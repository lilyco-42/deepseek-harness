/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionCancelParams,
  SessionCloseParams,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SdkApprovalOutcome,
  SdkApprovalRequestParams,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function isSdkApprovalOutcome(value: unknown): value is SdkApprovalOutcome {
  switch (value) {
    case 'allowed-once':
    case 'rejected':
    case 'cancelled':
    case 'unavailable': return true
    default: return false
  }
}

function approvalOutcome(value: unknown): ApprovalOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('outcome' in value)) return 'unavailable'
  return isSdkApprovalOutcome(value.outcome) ? value.outcome : 'unavailable'
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

function sessionIdParam(params: Record<string, unknown> | undefined, method: string): string {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError(`${method} params.sessionId must be a non-empty string`)
  }
  return sessionId
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly sessionClosures = new Map<string, Promise<void>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: [...info.lastAssistantMessage] }),
      }
      transport.notify('subagent.finished', payload)
    }))
    this.disposers.push(ctx.on('approval/request', async (request: ApprovalRequestEvent, next) => {
      const sessionId = String(request.agent.session.id)
      const record = this.sessions.get(sessionId)
      // Only an exact SDK-owned root agent may ask its host. Other agents in
      // this shared runtime remain available to their own composed answerers.
      if (record?.handle.agent !== request.agent) return next()
      const params: SdkApprovalRequestParams = {
        sessionId,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }
      // The request signal carries cancellation across JSON-RPC. The transport
      // sends $/cancelRequest so a host can dismiss its pending UI as well.
      try {
        return approvalOutcome(await transport.request('approval/request', params, request.signal))
      } catch {
        // A missing/disconnected host must deny the requested escalation.
        return request.signal?.aborted ? 'cancelled' : 'unavailable'
      }
    }))
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.initialized = true
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user' },
    })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Cancel the current work for one SDK-owned session.
   * @param params - the target session id.
   * @returns an empty result after cancellation is requested.
   */
  cancel(params: SessionCancelParams): Record<string, never> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const record = this.sessions.get(params.sessionId)
    if (record === undefined) {
      throw new Error(`SDK session is not open: ${params.sessionId}`)
    }
    this.assertLiveAgent(record, params.sessionId)
    record.handle.agent.cancel({ kind: 'user' })
    return {}
  }

  /**
   * Dispose one live SDK-owned agent while preserving the durable session so
   * a later prompt can reopen it.
   * @param params - the target session id.
   * @returns an empty result after the session is closed.
   */
  async closeSession(params: SessionCloseParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const sessionId = params.sessionId
    const activeClose = this.sessionClosures.get(sessionId)
    if (activeClose !== undefined) {
      await activeClose
      return {}
    }
    const closing = this.disposeSession(sessionId)
    this.sessionClosures.set(sessionId, closing)
    try {
      await closing
    } finally {
      this.sessionClosures.delete(sessionId)
    }
    return {}
  }

  private async disposeSession(sessionId: string): Promise<void> {
    let record = this.sessions.get(sessionId)
    if (record === undefined) {
      const pending = this.sessionCreations.get(sessionId)
      if (pending !== undefined) {
        record = await pending.catch(() => undefined)
      }
    }
    if (record !== undefined && this.sessions.get(sessionId) === record) {
      this.sessions.delete(sessionId)
      await record.handle.dispose()
    }
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.sessions.get(sessionId) !== rec) {
      throw new Error(`SDK session is not open: ${sessionId}`)
    }
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    const pendingClosures = [...this.sessionClosures.values()]
    await Promise.allSettled([...pendingCreations, ...pendingClosures])
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/cancel':
        return this.cancel({ sessionId: sessionIdParam(params, 'session/cancel') })
      case 'session/close':
        return this.closeSession({ sessionId: sessionIdParam(params, 'session/close') })
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    this.assertNotShuttingDown()
    const closing = this.sessionClosures.get(sessionId)
    if (closing !== undefined) {
      await closing
      this.assertNotShuttingDown()
    }
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
    const exactSessionId = brandString<SessionId>(sessionId)
    const agentOptions: AgentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    // Closing an SDK session disposes its live Agent but deliberately retains
    // the durable log. Check storage metadata before choosing create vs resume:
    // replaying an existing id through create fails with SessionAlreadyExists
    // and, more importantly, would lose the conversation the caller expects.
    const persistence = this.ctx.get('sessionPersistence')
    const stored = persistence === undefined ? undefined : await persistence.stat(exactSessionId)
    const handle = stored === undefined
      ? await this.ctx.agents.create({
        sessionId: exactSessionId,
        meta: { cwd: this.cwd },
        agentOptions,
      })
      : await this.ctx.agents.resume({
        resumeSessionId: exactSessionId,
        agentOptions,
      })
    if (this.shuttingDown) {
      await handle.dispose()
      throw new Error('SDK server is shutting down')
    }
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
