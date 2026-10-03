import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionRequestId } from '../src/types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const SESSION = SessionId('upload-session')

async function uploadHarness(origin?: 'subagent'): Promise<{
  ctx: Context
  controller: SessionCommandController
  uploads: FileUploads
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  selectForNextRequest: ReturnType<typeof vi.fn>
  saveFile: ReturnType<typeof vi.fn>
  saveFileStream: ReturnType<typeof vi.fn>
  saveImages: ReturnType<typeof vi.fn>
  disposeAgent: () => Promise<void>
  uploadRoute: (request: Request) => Promise<Response>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SESSION, {
    meta: { cwd: '/workspace', ...(origin === undefined ? {} : { origin }) },
  })
  const inbox = createInboxStub()
  const followup = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox,
    status: 'idle',
    ctx: undefined,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  const disposeAgent = await ctx.agents.register(agent)
  const saveFile = vi.fn((input: SaveFileAttachment): Promise<FileAttachmentRef> => Promise.resolve({
    attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
    name: input.name ?? 'file',
    bytes: input.data.byteLength,
  }))
  const saveFileStream = vi.fn(async (input: SaveFileStreamAttachment): Promise<FileAttachmentRef> => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return {
      attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
      name: input.name ?? 'file',
      bytes,
    }
  })
  const saveImages = vi.fn((): Promise<readonly ImageAttachmentRef[]> =>
    Promise.reject(new Error('fixture did not expect image persistence')))
  ctx.provide('attachments', Object.setPrototypeOf(
    { saveFile, saveFileStream, saveImages },
    AttachmentStore.prototype,
  ) as never)
  let uploadRoute: ((request: Request) => Promise<Response>) | undefined
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly fetch: (request: Request) => Promise<Response> }) => {
        uploadRoute = route.fetch
        return () => {}
      },
    },
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    resolveCallConfig: (input: { provider: string; model: string; reasoningEffort?: string }) =>
      Promise.resolve({ ...input }),
    resolveModelInfo: () => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }),
  } as never)
  const selection: Omit<ModelSelectionRef, 'current'> & {
    current: NonNullable<ModelSelectionRef['current']>
    consume: (_provider: string, _model: string, _reasoningEffort: string | undefined) => boolean
  } = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
    consume: () => false,
  }
  const admissionChains = new WeakMap<Agent, Promise<void>>()
  const selectForNextRequest = vi.fn((_target: Agent, next: NonNullable<ModelSelectionRef['current']>) => {
    selection.current = next
  })
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    ensureSession: () => { throw new Error('Unexpected ensureSession call in upload test') },
    presetForObservation: () => { throw new Error('Unexpected presetForObservation call in upload test') },
    presetForSession: () => { throw new Error('Unexpected presetForSession call in upload test') },
    selectForNextRequest,
    composeAgent: () => { throw new Error('Unexpected composeAgent call in upload test') },
    selectionFor: () => selection,
    serializeRequestAdmission: <Value>(target: Agent, operation: () => Promise<Value>) => {
      const result = (admissionChains.get(target) ?? Promise.resolve()).then(operation)
      admissionChains.set(target, result.then(() => undefined, () => undefined))
      return result
    },
  }
  const uploads = new FileUploads(ctx)
  if (uploadRoute === undefined) throw new Error('file upload route was not registered')
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    uploads,
    agent,
    followup,
    selectForNextRequest,
    saveFile,
    saveFileStream,
    saveImages,
    disposeAgent,
    uploadRoute,
  }
}

function promptRequest(content: Parameters<SessionCommandController['prompt']>[0]['content']) {
  return {
    requestId: 'req-1' as SessionRequestId,
    sessionId: SESSION,
    mode: 'queue' as const,
    content,
  }
}

function emitTurnEnd(ctx: Context, agent: Agent): void {
  ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    seq: SessionSeq(1),
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'completed' } },
  })
}

describe('Session file uploads', () => {
  it('registers an HTTP route bound to the upload service', async () => {
    const { uploadRoute } = await uploadHarness()
    await expect(uploadRoute(new Request('http://host/upload')))
      .resolves.toMatchObject({ status: 405 })
  })

  it('stages one verbatim upload and preserves its order with an admitted image', async () => {
    const { ctx, controller, uploads, agent, followup, saveFile, saveImages } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA', name: 'notes.pdf' }, new AbortController().signal)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(receipt.file.name).toBe('notes.pdf')
    expect(receipt.file.bytes).toBe(3)
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    expect(uploads.resolve(agent, 'missing' as FileUploadReceiptId)).toBeUndefined()
    const commandHandler = vi.fn((_invocation: unknown) => ({ kind: 'success' as const }))
    ctx.commands.register({
      name: 'files', description: 'Use staged files', input: { hint: '<task>', attachments: true },
      handler: commandHandler,
    })
    await ctx.commands.execute(
      agent,
      '/files inspect',
      [{ type: 'file', receiptId: receipt.receiptId }],
      new AbortController().signal,
    )
    expect(commandHandler.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ type: 'file', attachment: receipt.file }],
    })
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    saveImages.mockResolvedValueOnce([image])
    await controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'read it' },
    ]))
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: receipt.file },
      { type: 'image', attachment: image },
      { type: 'text', text: 'read it' },
    ])
  })

  it('stages a bounded byte stream and forwards cancellation to storage', async () => {
    const { controller, uploads, followup, saveFileStream } = await uploadHarness()
    const abort = new AbortController()
    const receipt = await uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4, 5)
      })(),
      signal: abort.signal,
      name: 'huge.bin',
    })
    expect(saveFileStream).toHaveBeenCalledWith(expect.objectContaining({
      signal: abort.signal,
      name: 'huge.bin',
    }))
    expect(receipt.file).toMatchObject({ name: 'huge.bin', bytes: 5 })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'file', attachment: receipt.file },
    ])
  })

  it('keeps the stream name optional and maps storage failures through the same error vocabulary', async () => {
    const { uploads, saveFileStream } = await uploadHarness()
    const stream = (async function* (): AsyncIterable<Uint8Array> {})()
    await expect(uploads.uploadStream({ sessionId: SESSION, data: stream }))
      .resolves.toMatchObject({ file: { name: 'file', bytes: 0 } })
    expect(saveFileStream).toHaveBeenLastCalledWith({ data: stream })
    saveFileStream.mockRejectedValueOnce('disk offline')
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    }))
      .rejects.toMatchObject({
        code: 'gateway/internal', message: 'failed to store file upload: disk offline',
      })
  })

  it('rejects a prompt citing a file that was never staged for the session', async () => {
    const { controller, followup, saveImages } = await uploadHarness()
    await expect(controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'file', receiptId: 'missing-receipt' as FileUploadReceiptId },
    ]))).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } })
    expect(followup).not.toHaveBeenCalled()
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('publishes no receipt when its exact Agent is disposed during storage', async () => {
    const { uploads, agent, saveFile, disposeAgent } = await uploadHarness()
    const saved = Promise.withResolvers<FileAttachmentRef>()
    saveFile.mockReturnValueOnce(saved.promise)
    const uploading = uploads.upload(agent, { data: 'AAAA', name: 'late.bin' }, new AbortController().signal)
    await vi.waitFor(() => { expect(saveFile).toHaveBeenCalledOnce() })
    await disposeAgent()
    saved.resolve({
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name: 'late.bin', bytes: 3,
    })
    await expect(uploading).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('resolves a cold ordinary Agent and releases the resolver registration', async () => {
    const { ctx, uploads, agent, disposeAgent } = await uploadHarness()
    await disposeAgent()
    const resolveAgent = vi.fn(async () => {
      await ctx.agents.register(agent)
      return agent
    })
    const disposeResolver = uploads.registerAgentResolver(resolveAgent)
    expect(() => { uploads.registerAgentResolver(resolveAgent) }).toThrow('already registered')
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    })).resolves.toMatchObject({ file: { bytes: 1 } })
    expect(resolveAgent).toHaveBeenCalledWith(SESSION)
    disposeResolver()
    const replacement = vi.fn(async () => agent)
    const disposeReplacement = uploads.registerAgentResolver(replacement)
    disposeResolver()
    expect(() => { uploads.registerAgentResolver(replacement) }).toThrow('already registered')
    expect(disposeReplacement).toBeTypeOf('function')
    disposeReplacement()
  })

  it('rejects a cold upload when no Agent resolver is registered', async () => {
    const { uploads, disposeAgent } = await uploadHarness()
    await disposeAgent()
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {})(),
    })).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects subagent uploads and access outside the receiving Agent scope', async () => {
    const child = await uploadHarness('subagent')
    await expect(child.uploads.upload(
      child.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'subagent/attachment-invalid',
      details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
    })
    expect(child.saveFile).not.toHaveBeenCalled()

    const ordinary = await uploadHarness()
    const receipt = await ordinary.uploads.upload(
      ordinary.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    const foreignScope = { ...ordinary.agent, ctx: ordinary.ctx } as Agent
    expect(() => ordinary.uploads.resolve(foreignScope, receipt.receiptId))
      .toThrow('operation requires the Agent\'s own scope')
  })

  it('retires accepted receipts after their rpcId becomes observable', async () => {
    const { controller, uploads, agent } = await uploadHarness()
    uploads.retirePrompt(agent, 'not-staged')
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    uploads.retirePrompt(agent, 'other-request')
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('retires observed prompt receipts and drops staged state with the Session', async () => {
    const first = await uploadHarness()
    const observed = await first.uploads.upload(
      first.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    await first.controller.prompt(promptRequest([{ type: 'file', receiptId: observed.receiptId }]))
    first.ctx.emit('session/event', first.agent.session, {
      type: 'user/message',
      data: createUserMessage({
        content: [{ type: 'text', text: 'extension event' }],
        source: { kind: 'user', rpcId: 1 } as never,
      }),
    } as never)
    expect(first.uploads.resolve(first.agent, observed.receiptId)).toEqual(observed.file)
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'observed' }],
      source: { kind: 'user', rpcId: 'req-1' as SessionRequestId },
    }), { surfaceOp: 'append' })
    expect(first.uploads.resolve(first.agent, observed.receiptId)).toBeUndefined()

    const second = await uploadHarness()
    const abandoned = await second.uploads.upload(
      second.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    second.ctx.emit('session/disposed', second.agent.session)
    expect(second.uploads.resolve(second.agent, abandoned.receiptId)).toBeUndefined()
  })

  it('deduplicates a retried rpcId already present in the Agent inbox', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request)
    agent.inbox.append('next-turn', followup.mock.calls[0]?.[0] as UserMessage)
    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent retries while an accepted image prompt is not durable yet', async () => {
    const { controller, saveImages, followup } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId('concurrent-image'),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    const request = promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }])

    const first = controller.prompt(request)
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    const retry = controller.prompt(request)
    admitted.resolve([image])

    await expect(Promise.all([first, retry])).resolves.toEqual([
      { accepted: true },
      { accepted: true },
    ])
    expect(saveImages).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
  })

  it('rejects a concurrent request id reused with different content', async () => {
    const { controller, saveImages, followup } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId('concurrent-image'),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    const request = promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }])

    const first = controller.prompt(request)
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    const changed = controller.prompt({
      ...request,
      content: [{ type: 'text', text: 'different request' }],
    })
    admitted.resolve([image])

    await expect(first).resolves.toEqual({ accepted: true })
    await expect(changed).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(saveImages).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
  })

  it('rejects a durable request id reused with another prompt, model or Agent context', async () => {
    const { controller, followup, selectForNextRequest } = await uploadHarness()
    const request = {
      ...promptRequest([{ type: 'text', text: 'same prompt' }]),
      modelSelection: { provider: 'fixture', model: 'first-model' },
      requestContextDigest: 'a'.repeat(64),
    }
    await controller.prompt(request)
    expect((followup.mock.calls[0]?.[0] as UserMessage).source).toHaveProperty('requestDigest')

    await expect(controller.prompt({
      ...request,
      content: [{ type: 'text', text: 'different prompt' }],
    })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    await expect(controller.prompt({
      ...request,
      modelSelection: { provider: 'fixture', model: 'different-model' },
    })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    await expect(controller.prompt({
      ...request,
      requestContextDigest: 'b'.repeat(64),
    })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(followup).toHaveBeenCalledOnce()
    expect(selectForNextRequest).toHaveBeenCalledOnce()
  })

  it('logs application request context and rejects permission changes on the same identity', async () => {
    const { ctx, controller, followup } = await uploadHarness()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const request = {
      ...promptRequest([{ type: 'text', text: 'Read public sources only.' }]),
      requestContext: { lain42: { version: 1, toolScope: 'public-only' } },
    }
    await controller.prompt(request)
    expect((followup.mock.calls[0]?.[0] as UserMessage).source).toMatchObject({
      kind: 'user',
      requestContext: { lain42: { version: 1, toolScope: 'public-only' } },
    })
    const changed = {
      ...request,
      requestContext: { lain42: { version: 1, toolScope: 'account-read' } },
    }
    await expect(controller.prompt(changed)).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('retains context and retry identity across command-owner replacement', async () => {
    const first = await uploadHarness()
    const second = await uploadHarness()
    onTestFinished(async () => {
      await first.ctx.fiber.dispose()
      await second.ctx.fiber.dispose()
    })
    const request = {
      ...promptRequest([{ type: 'text', text: 'Public sources only' }]),
      requestContext: { lain42: { version: 1, toolScope: 'public-only' } },
    }
    await first.controller.prompt(request)
    const original = first.followup.mock.calls[0]?.[0] as UserMessage
    second.agent.session.append('user/message', original, { surfaceOp: 'append' })
    await expect(second.controller.prompt(request)).resolves.toEqual({ accepted: true })
    await expect(second.controller.prompt({ ...request, requestContext: null })).rejects.toMatchObject({
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    await expect(second.controller.prompt({ ...request, requestContext: undefined })).rejects.toMatchObject({
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(second.followup).not.toHaveBeenCalled()
    expect(second.selectForNextRequest).not.toHaveBeenCalled()
  })

  it('snapshots context before asynchronous attachment admission', async () => {
    const { ctx, controller, saveImages, followup } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const requestContext = { lain42: { version: 1, toolScope: 'public-only' } }
    const request = {
      ...promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]),
      requestContext,
    }
    const pending = controller.prompt(request)
    onTestFinished(async () => {
      admitted.resolve([])
      try { await pending }
      catch (error) { /* An early test failure can release admission without image bytes. */ }
      finally { await ctx.fiber.dispose() }
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    requestContext.lain42.toolScope = 'account-read'
    const retry = controller.prompt(request)
    admitted.resolve([{
      attachmentId: AttachmentId('context-image'), mediaType: 'image/png',
      bytes: 3, width: 1, height: 1,
    }])
    await expect(pending).resolves.toEqual({ accepted: true })
    await expect(retry).rejects.toMatchObject({
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect((followup.mock.calls[0]?.[0] as UserMessage).source).toHaveProperty(
      'requestContext', { lain42: { version: 1, toolScope: 'public-only' } },
    )
    expect(followup).toHaveBeenCalledOnce()
  })

  it.each<{ value: JsonValue }>([
    { value: null }, { value: false }, { value: 1 },
    { value: ['public', { enabled: true }] },
    { value: 'x'.repeat(8190) }, { value: '界'.repeat(2730) },
  ])(
    'logs bounded JSON context without changing prompt content (%#)', async ({ value: requestContext }) => {
      const { ctx, controller, followup } = await uploadHarness()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      const content = [{ type: 'text' as const, text: 'Only this text enters the prompt' }]
      await controller.prompt({ ...promptRequest(content), requestContext })
      const message = followup.mock.calls[0]?.[0] as UserMessage
      expect(message.source).toHaveProperty('requestContext', requestContext)
      expect(message.content).toEqual(content)
    },
  )

  it('rejects lossy or oversized context before selecting a model or delivering work', async () => {
    const { ctx, controller, followup, selectForNextRequest } = await uploadHarness()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const cycle: { [key: string]: JsonValue } = {}
    cycle['self'] = cycle
    let nested: JsonValue = null
    for (let depth = 0; depth < 20_000; depth++) nested = [nested]
    for (const requestContext of [NaN, Infinity, cycle, nested, 'x'.repeat(8191), '界'.repeat(2731)]) {
      await expect(controller.prompt({
        ...promptRequest([{ type: 'text', text: 'Do not admit invalid metadata' }]),
        requestContext,
        modelSelection: { provider: 'fixture', model: 'other-model' },
      })).rejects.toMatchObject({
        code: 'gateway/bad-request', details: { issues: [{ reason: 'INVALID_REQUEST_CONTEXT' }] },
      })
    }
    expect(followup).not.toHaveBeenCalled()
    expect(selectForNextRequest).not.toHaveBeenCalled()
  })

  it('rejects malformed context digests and unserved prompt model selections before delivery', async () => {
    const { controller, followup, selectForNextRequest } = await uploadHarness()
    const base = promptRequest([{ type: 'text', text: 'valid prompt' }])

    await expect(controller.prompt({ ...base, requestContextDigest: 'not-a-digest' })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'INVALID_REQUEST_CONTEXT_DIGEST' }] },
    })
    await expect(controller.prompt({
      ...base,
      modelSelection: { provider: 'not-served', model: 'missing-model' },
    })).rejects.toMatchObject({
      code: 'session/model-unavailable',
      details: { provider: 'not-served', model: 'missing-model' },
    })
    expect(followup).not.toHaveBeenCalled()
    expect(selectForNextRequest).not.toHaveBeenCalled()
  })

  it('rejects a durable request id already bound to conflicting messages', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'same prompt' }])
    for (const requestDigest of ['a'.repeat(64), 'b'.repeat(64)]) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'same prompt' }],
        source: { kind: 'user', rpcId: request.requestId, requestDigest },
      }), { surfaceOp: 'append' })
    }

    await expect(controller.prompt(request)).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(followup).not.toHaveBeenCalled()
  })

  it('keeps a pending request id through turn end while its message is still queued', async () => {
    const { ctx, controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    followup.mockImplementation((message: UserMessage) => { agent.inbox.append('next-step', message) })

    await controller.prompt(request)
    emitTurnEnd(ctx, agent)
    agent.inbox.clear()

    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('retires pending request ids at turn end when no queued source matches', async () => {
    const { ctx, controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request)
    agent.inbox.append('next-turn', createUserMessage({
      content: [],
      source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
    }))
    agent.inbox.append('next-turn', createUserMessage({ content: [], source: { kind: 'user' } }))
    agent.inbox.append('next-step', createUserMessage({
      content: [],
      source: { kind: 'user', rpcId: 42 as never },
    }))

    emitTurnEnd(ctx, agent)

    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('clears pending request ids when the Agent has been disposed before turn end', async () => {
    const { ctx, controller, agent, disposeAgent } = await uploadHarness()
    await controller.prompt(promptRequest([{ type: 'text', text: 'once' }]))
    await disposeAgent()

    expect(() => { emitTurnEnd(ctx, agent) }).not.toThrow()
  })

  it('retains a pending id when delivery enqueues the prompt before rejecting', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    followup.mockImplementationOnce((message: UserMessage) => {
      agent.inbox.append('next-turn', message)
      throw new Error('rejected after enqueue')
    })

    await expect(controller.prompt(request)).rejects.toMatchObject({ code: 'session/agent-busy' })
    agent.inbox.clear()
    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('releases a request id when Agent admission rejects before delivery', async () => {
    const { controller, saveImages, followup } = await uploadHarness()
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId('retry-image'),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    saveImages.mockResolvedValue([image])
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    const request = promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }])

    await expect(controller.prompt(request)).rejects.toMatchObject({ code: 'session/agent-busy' })
    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(saveImages).toHaveBeenCalledTimes(2)
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('deduplicates a retried rpcId already present in the durable log', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request)
    const admitted = followup.mock.calls[0]?.[0] as UserMessage
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', admitted, { surfaceOp: 'append' })

    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it.each(['next-turn', 'next-step'] as const)(
    'keeps a removed %s prompt identity after pending admission memory retires',
    async (target) => {
      const { ctx, controller, agent, followup } = await uploadHarness()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      const request = promptRequest([{ type: 'text', text: 'do not resurrect this request' }])
      await controller.prompt(request)
      const admitted = followup.mock.calls[0]?.[0] as UserMessage
      agent.session.append('agent/inbox/spliced', { target, start: 0, inserted: [admitted] })
      agent.inbox.append(target, admitted)
      await controller.updateQueue({ sessionId: SESSION, itemId: admitted.id, action: { kind: 'remove' } })
      agent.session.append('agent/inbox/spliced', {
        target, start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      })
      emitTurnEnd(ctx, agent)

      await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
      expect(followup).toHaveBeenCalledOnce()
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
      await expect(controller.prompt({
        ...request, content: [{ type: 'text', text: 'changed after removal' }],
      })).rejects.toMatchObject({
        code: 'gateway/bad-request',
        details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
      })
      expect(followup).toHaveBeenCalledOnce()
    },
  )

  it('rejects a removed legacy queue identity without an original digest', async () => {
    const { ctx, controller, agent, followup } = await uploadHarness()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const request = promptRequest([{ type: 'text', text: 'legacy queued prompt' }])
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'legacy queued prompt' }],
      source: { kind: 'user', rpcId: request.requestId },
    })
    agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    })

    await expect(controller.prompt(request)).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects conflicting queue and user-message digests for one request id', async () => {
    const { ctx, controller, agent, followup } = await uploadHarness()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const request = promptRequest([{ type: 'text', text: 'original queued prompt' }])
    await controller.prompt(request)
    const admitted = followup.mock.calls[0]?.[0] as UserMessage
    agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [admitted] })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'conflicting prompt' }],
      source: { kind: 'user', rpcId: request.requestId, requestDigest: 'b'.repeat(64) },
    }), { surfaceOp: 'append' })

    await expect(controller.prompt(request)).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('rejects a legacy durable request id whose original payload cannot be verified', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'once' }],
      source: { kind: 'user', rpcId: request.requestId },
    }), { surfaceOp: 'append' })

    await expect(controller.prompt(request)).rejects.toMatchObject({
      code: 'gateway/bad-request',
      details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
    })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects when the Agent disappears during prompt admission', async () => {
    const { controller, saveImages, disposeAgent } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]))
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    await disposeAgent()
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects when a previously bound receipt retires during image admission', async () => {
    const { controller, uploads, agent, saveImages } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt({
      ...promptRequest([
        { type: 'file', receiptId: receipt.receiptId },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ]),
      requestId: 'req-2' as SessionRequestId,
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    uploads.retirePrompt(agent, 'req-1')
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
  })

  it('keeps the prior receipt binding when a later prompt attempt fails', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt({
      ...promptRequest([{ type: 'file', receiptId: receipt.receiptId }]),
      requestId: 'req-2' as SessionRequestId,
    })).rejects.toMatchObject({ code: 'session/agent-busy' })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('restores an unbound receipt after prompt delivery fails', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
    ]))).rejects.toMatchObject({ code: 'session/agent-busy' })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
  })

  it('retires a prompt-bound receipt when its queued occurrence is removed', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    agent.inbox.append('next-turn', queued)
    expect(await controller.updateQueue({
      sessionId: SESSION,
      itemId: queued.id,
      action: { kind: 'remove' },
    })).toEqual({ accepted: true })
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('keeps separate names for identical bytes uploaded more than once', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const first = await uploads.upload(agent, { data: 'AAAA', name: 'first.txt' }, new AbortController().signal)
    const second = await uploads.upload(agent, { data: 'AAAA', name: 'second.txt' }, new AbortController().signal)
    expect(first.file.attachmentId).toBe(second.file.attachmentId)
    expect(first.receiptId).not.toBe(second.receiptId)

    await controller.prompt(promptRequest([
      { type: 'file', receiptId: first.receiptId },
      { type: 'file', receiptId: second.receiptId },
    ]))

    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: first.file },
      { type: 'file', attachment: second.file },
    ])
  })

  it('maps a non-canonical payload to the wire attachment error', async () => {
    const { uploads, agent, saveFile } = await uploadHarness()
    await expect(uploads.upload(agent, { data: 'not base64!!' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'INVALID_FILE_BASE64' } })
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('maps an unexpected storage failure to the internal wire error', async () => {
    const { uploads, agent, saveFile } = await uploadHarness()
    saveFile.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'failed to store file upload: Error: disk unavailable',
      })
  })
})
