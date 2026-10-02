/** Private, authenticated turn endpoint for the Lain42 server control plane. */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionFollowFrame,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'

/** Exact server-only path for HMAC-authenticated Lain42 Agent turns. */
export const LAIN42_BRIDGE_PATH = '/lain42/bridge/v1/turn'
/** Exact server-only path for cancellation of an original prompt identity. */
export const LAIN42_CANCEL_PATH = '/lain42/bridge/v1/cancel'

const BODY_LIMIT_BYTES = 12 * 1024 * 1024
const PROMPT_LIMIT_BYTES = 24 * 1024
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
const SIGNATURE_WINDOW_SECONDS = 60
const TURN_TIMEOUT_MS = 120_000
const FOLLOW_MAX_MESSAGES = 50
const PRESET_ID = 'lain42-web'
const PRESET_BY_MODE = {
  general: 'lain42-web',
  coding: 'lain42-web-coding',
  research: 'lain42-web-research',
  content: 'lain42-web-content',
} as const
const NONCE_LIMIT = 10_000

type Lain42AgentMode = keyof typeof PRESET_BY_MODE
type Lain42ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

interface Lain42TurnImage {
  readonly mediaType: Lain42ImageMediaType
  /** Canonical standard Base64 bytes; decoded and validated by the Session attachment store. */
  readonly data: string
}

interface Lain42TurnRequest {
  readonly version: 1 | 2
  readonly sessionId: string
  readonly requestId: string
  readonly model: string
  readonly mode: Lain42AgentMode
  readonly text: string
  readonly images?: readonly Lain42TurnImage[]
}

type TurnResult =
  | { readonly answer: string }
  | { readonly failure: 'not-found' | 'failed' }

interface SessionEventRecord {
  readonly type: string
  readonly data: unknown
}

/** Register the exact server-to-server route and release it with this plugin.
 * @param ctx Host context that owns the web server and session controller.
 * @param secret Shared HMAC secret used to authenticate New API requests.
 */
export function registerLain42Bridge(ctx: Context, secret: string | undefined): void {
  const sessionController = ctx.get('sessionController')
  if (sessionController === undefined) {
    throw new Error('Lain42 bridge requires the DSH session-controller service')
  }
  if (secret === undefined || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Lain42 bridge requires LAIN42_DSH_BRIDGE_SECRET with at least 32 UTF-8 bytes')
  }
  const handler = createLain42BridgeHandler(sessionController, secret, (message) => {
    ctx.logger.warn(message)
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LAIN42_BRIDGE_PATH,
    handler,
  }), 'web-app: Lain42 private turn bridge')
  const cancelHandler = createLain42CancellationHandler(sessionController, secret, (message) => {
    ctx.logger.warn(message)
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LAIN42_CANCEL_PATH,
    handler: cancelHandler,
  }), 'web-app: Lain42 private cancellation bridge')
}

/** Create a private original-request cancellation handler; a receipt is not settlement.
 * @param sessionController DSH service that cancels one original prompt identity.
 * @param secret Shared server-only HMAC secret.
 * @param logWarning Receives diagnostics without request data or credentials.
 * @returns The signed cancellation route handler.
 */
export function createLain42CancellationHandler(
  sessionController: Pick<SessionController, 'cancelPrompt'>,
  secret: string,
  logWarning: (message: string) => void,
): WebRoute['handler'] {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Lain42 bridge secret must contain at least 32 UTF-8 bytes')
  }
  const nonces = new Map<string, number>()
  return async (request, response) => {
    const bytes = await readSignedBody(request, response, secret, nonces, LAIN42_CANCEL_PATH, 4096)
    if (bytes === undefined) return
    let record: Record<string, unknown> | undefined
    try {
      record = asRecord(JSON.parse(bytes.toString('utf8')))
    } catch {
      record = undefined
    }
    if (record?.version !== 1 || Object.keys(record).some(key => !['version', 'sessionId', 'requestId'].includes(key))
      || typeof record.sessionId !== 'string' || !/^[A-Za-z0-9]{64}$/u.test(record.sessionId)
      || typeof record.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.requestId)) {
      writeJson(response, 400, { error: 'invalid_request' })
      return
    }
    try {
      const receipt = await sessionController.cancelPrompt({
        sessionId: brandString<SessionId>(record.sessionId),
        requestId: brandString<SessionRequestId>(record.requestId),
      })
      writeJson(response, 200, { version: 1, sessionId: record.sessionId, requestId: record.requestId, ...receipt })
    } catch (error) {
      logWarning(`Lain42 bridge cancellation unavailable (${error instanceof Error ? error.name : 'unknown'})`)
      writeJson(response, 502, { error: 'agent_cancellation_unavailable' })
    }
  }
}

/** Create the authenticated handler used by the route and its wire tests.
 * @param sessionController DSH service that creates, prompts, and follows sessions.
 * @param secret Shared HMAC secret used to authenticate each request.
 * @param logWarning Receives safe diagnostics without request content or secrets.
 * @returns A web route handler for the private turn endpoint.
 */
export function createLain42BridgeHandler(
  sessionController: Pick<SessionController, 'create' | 'prompt' | 'follow' | 'cancel'>,
  secret: string,
  logWarning: (message: string) => void,
): WebRoute['handler'] {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Lain42 bridge secret must contain at least 32 UTF-8 bytes')
  }
  const nonces = new Map<string, number>()
  return (request, response) => handleTurn(request, response, sessionController, secret, nonces, logWarning)
}

/** Verify a signed request, run the selected web-safe Session preset, and return its final text. */
async function handleTurn(
  request: IncomingMessage,
  response: ServerResponse,
  sessionController: Pick<SessionController, 'create' | 'prompt' | 'follow' | 'cancel'>,
  secret: string,
  nonces: Map<string, number>,
  logWarning: (message: string) => void,
): Promise<void> {
  const bytes = await readSignedBody(request, response, secret, nonces, LAIN42_BRIDGE_PATH, BODY_LIMIT_BYTES)
  if (bytes === undefined) return
  const turnRequest = parseTurnRequest(bytes)
  if (turnRequest === undefined) {
    writeJson(response, 400, { error: 'invalid_request' })
    return
  }

  const sessionId = brandString<SessionId>(turnRequest.sessionId)
  const requestId = brandString<SessionRequestId>(turnRequest.requestId)
  const controller = new AbortController()
  const timeoutReason = new Error('Lain42 bridge turn timed out')
  const timer = setTimeout(() => {
    controller.abort(timeoutReason)
  }, TURN_TIMEOUT_MS)
  let promptAccepted = false
  let targetTurn: number | undefined
  try {
    await sessionController.create({
      sessionId,
      agentPreset: PRESET_BY_MODE[turnRequest.mode],
    })
    const content: SessionPromptRequest['content'] = [
      ...(turnRequest.text.trim().length === 0 ? [] : [{ type: 'text' as const, text: turnRequest.text }]),
      ...(turnRequest.images ?? []).map(image => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: image.data,
      })),
    ]
    await sessionController.prompt({
      sessionId,
      requestId,
      mode: 'queue',
      modelSelection: { provider: PRESET_ID, model: turnRequest.model },
      requestContextDigest: requestContextDigest(turnRequest),
      content,
    }, controller.signal)
    promptAccepted = true
    const result = await collectTurn(sessionController, sessionId, requestId, controller.signal, (turn) => {
      targetTurn = turn
    })
    if ('failure' in result) {
      writeJson(response, 502, {
        error: result.failure === 'not-found' ? 'agent_turn_unavailable' : 'agent_turn_failed',
      })
      return
    }
    writeJson(response, 200, { version: 1, requestId: turnRequest.requestId, answer: result.answer })
  } catch (error) {
    const timedOut = controller.signal.reason === timeoutReason
    if (timedOut && promptAccepted) {
      if (targetTurn === undefined) {
        logWarning('Lain42 bridge timed out before its turn was observed; cancellation skipped')
      } else {
        try {
          // Scope cancellation to the exact turn; a delayed waiter must not stop newer work.
          sessionController.cancel({ sessionId, turn: targetTurn })
        } catch (cancelError) {
          logWarning(`Lain42 bridge cancellation request failed (${cancelError instanceof Error ? cancelError.name : 'unknown'})`)
        }
      }
    }
    if (isRequestIdConflict(error)) {
      writeJson(response, 409, { error: 'request_id_conflict' })
      return
    }
    const status = timedOut ? 504 : 502
    const code = timedOut ? 'agent_turn_timeout' : 'agent_turn_failed'
    logWarning(`Lain42 bridge ${code} (${error instanceof Error ? error.name : 'unknown'})`)
    writeJson(response, status, { error: code })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Enforce the operation-bound signature and bounded body before touching a Session. */
async function readSignedBody(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  nonces: Map<string, number>,
  operationPath: string,
  limit: number,
): Promise<Buffer | undefined> {
  response.setHeader('cache-control', 'no-store')
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return undefined
  }
  if (singleHeader(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    writeJson(response, 415, { error: 'content_type_required' })
    return undefined
  }
  let bytes: Buffer
  try {
    bytes = await readBody(request, limit)
  } catch (error) {
    writeJson(response, error instanceof BodyLimitError ? 413 : 400, { error: 'invalid_request' })
    return undefined
  }
  if (!verifySignature(secret, bytes, singleHeader(request, 'x-lain42-timestamp'),
    singleHeader(request, 'x-lain42-nonce'), singleHeader(request, 'x-lain42-signature'), nonces, operationPath)) {
    writeJson(response, 401, { error: 'unauthorized' })
    return undefined
  }
  return bytes
}

/** Follow durable events so retries can recover the result already committed for the same request id. */
async function collectTurn(
  sessionController: Pick<SessionController, 'create' | 'prompt' | 'follow'>,
  sessionId: SessionId,
  requestId: SessionRequestId,
  signal: AbortSignal,
  onTargetTurn: (turn: number) => void,
): Promise<TurnResult> {
  let currentTurn: number | undefined
  let targetTurn: number | undefined
  let answer: string | undefined
  const queues: Record<'next-turn' | 'next-step', unknown[]> = { 'next-turn': [], 'next-step': [] }
  for await (const frame of sessionController.follow({
    address: { kind: 'session', sessionId },
    maxMessages: FOLLOW_MAX_MESSAGES,
  }, signal)) {
    const events = eventsFromFrame(frame)
    for (const event of events) {
      const data = asRecord(event.data)
      if (data === undefined) continue
      if (event.type === 'agent/inbox/spliced') {
        const target = data.target
        const start = finiteNumber(data.start)
        const removedCount = data.removedCount === undefined ? 0 : finiteNumber(data.removedCount)
        if ((target !== 'next-turn' && target !== 'next-step') || start === undefined
          || removedCount === undefined || !Array.isArray(data.inserted)) continue
        const inserted = data.inserted.map((message: unknown): unknown => message)
        const removed = queues[target].splice(start, removedCount, ...inserted)
        const matching = removed.some((message) => {
          const source = asRecord(asRecord(message)?.source)
          return source?.kind === 'user' && source.rpcId === requestId
        })
        if (!matching) continue
        // Inbox removals are committed before user/message; a queued Stop has
        // no turn/end, while an exact claim can abort before its first message.
        if (data.outcome === 'canceled') return { failure: 'failed' }
        targetTurn = currentTurn
        if (targetTurn !== undefined) onTargetTurn(targetTurn)
        answer = undefined
      } else if (event.type === 'turn/start') {
        currentTurn = finiteNumber(data.turn)
      } else if (event.type === 'user/message') {
        const source = asRecord(data.source)
        if (source?.kind === 'user' && source.rpcId === requestId) {
          targetTurn = currentTurn
          if (targetTurn !== undefined) onTargetTurn(targetTurn)
          answer = undefined
        }
      } else if (event.type === 'assistant/message' && finiteNumber(data.turn) === targetTurn) {
        answer = textFromAssistant(data.message)
      } else if (event.type === 'turn/end' && finiteNumber(data.turn) === targetTurn) {
        const reason = asRecord(data.reason)
        return reason?.kind === 'completed' && answer !== undefined
          ? { answer }
          : { failure: 'failed' }
      }
    }
  }
  return { failure: 'not-found' }
}

/** Bind bridge-only Agent mode to the durable identity of a prompt request. */
function requestContextDigest(request: Lain42TurnRequest): string {
  return createHash('sha256').update(JSON.stringify({ mode: request.mode })).digest('hex')
}

function isRequestIdConflict(error: unknown): boolean {
  const record = asRecord(error)
  const details = asRecord(record?.details)
  const issues = details?.issues
  return record?.code === 'gateway/bad-request'
    && Array.isArray(issues)
    && issues.some(issue => asRecord(issue)?.reason === 'REQUEST_ID_CONFLICT')
}

function eventsFromFrame(frame: SessionFollowFrame): readonly SessionEventRecord[] {
  if (frame.type === 'snapshot') return frame.records.map(record => record.event)
  if (frame.type === 'event') return [frame.event]
  return []
}

function textFromAssistant(value: unknown): string | undefined {
  const message = asRecord(value)
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((part) => {
    const block = asRecord(part)
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('')
  return text.length > 0 ? text : undefined
}

function parseTurnRequest(bytes: Buffer): Lain42TurnRequest | undefined {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  const record = asRecord(value)
  if (record === undefined) return undefined
  const keys = Object.keys(record).sort()
  const requiredKeys = ['model', 'requestId', 'sessionId', 'text', 'version']
  if (requiredKeys.some(key => !keys.includes(key))
    || keys.some(key => key !== 'model' && key !== 'mode' && key !== 'images' && !requiredKeys.includes(key))) return undefined
  if ((record.version !== 1 && record.version !== 2) || typeof record.sessionId !== 'string'
    || !/^[A-Za-z0-9]{64}$/.test(record.sessionId)
    || typeof record.requestId !== 'string'
    // New API derives deterministic UUIDv5 IDs from account-scoped message
    // keys so a retry can recover the already completed DSH turn.
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId)
    || typeof record.text !== 'string'
    || Buffer.byteLength(record.text, 'utf8') > PROMPT_LIMIT_BYTES) return undefined
  const hasImagesField = Object.hasOwn(record, 'images')
  const images = hasImagesField ? parseImages(record.images) : undefined
  if (record.version === 1 && hasImagesField) return undefined
  if (record.version === 2 && (images === undefined || images.length === 0)) return undefined
  if (record.text.trim().length === 0 && (images?.length ?? 0) === 0) return undefined
  const model = record.model
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) return undefined
  const mode = record.mode === undefined ? 'general' : record.mode
  if (typeof mode !== 'string' || !Object.hasOwn(PRESET_BY_MODE, mode)) return undefined
  return {
    version: record.version,
    sessionId: record.sessionId,
    requestId: record.requestId,
    model,
    mode: mode as Lain42AgentMode,
    text: record.text,
    ...(images === undefined ? {} : { images }),
  }
}

function parseImages(value: unknown): readonly Lain42TurnImage[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGES) return undefined
  const images: Lain42TurnImage[] = []
  let totalBytes = 0
  for (const item of value) {
    const record = asRecord(item)
    if (record === undefined
      || Object.keys(record).some(key => key !== 'mediaType' && key !== 'data')
      || (record.mediaType !== 'image/png' && record.mediaType !== 'image/jpeg'
        && record.mediaType !== 'image/webp' && record.mediaType !== 'image/gif')
      || typeof record.data !== 'string' || record.data.length === 0
      || record.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return undefined
    const data = record.data
    const decodedBytes = Buffer.from(data, 'base64')
    if (decodedBytes.byteLength === 0 || decodedBytes.toString('base64') !== data
      || decodedBytes.byteLength > MAX_IMAGE_BYTES) return undefined
    totalBytes += decodedBytes.byteLength
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return undefined
    images.push({ mediaType: record.mediaType, data })
  }
  return images
}

/** Compute the v1 signature sent by the authenticated New API service.
 * @param secret Shared HMAC secret for the bridge.
 * @param timestamp Unix timestamp in seconds included in the signed headers.
 * @param nonce Unique 128-bit lowercase hexadecimal request nonce.
 * @param body Exact UTF-8 request bytes whose digest is included in the signature.
 * @param operationPath Exact turn or cancellation path; defaults to turn.
 * @returns Lowercase hexadecimal HMAC-SHA256 signature.
 */
export function signLain42BridgeRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
  operationPath: typeof LAIN42_BRIDGE_PATH | typeof LAIN42_CANCEL_PATH = LAIN42_BRIDGE_PATH,
): string {
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  const canonical = `v1\n${timestamp}\n${nonce}\nPOST\n${operationPath}\n${bodyDigest}`
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

function verifySignature(
  secret: string,
  body: Buffer,
  timestamp: string | undefined,
  nonce: string | undefined,
  signature: string | undefined,
  nonces: Map<string, number>,
  operationPath: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (timestamp === undefined || !/^\d{10}$/.test(timestamp)
    || nonce === undefined || !/^[0-9a-f]{32}$/.test(nonce)
    || signature === undefined || !/^[0-9a-f]{64}$/.test(signature)) return false
  const parsedTimestamp = Number(timestamp)
  if (Math.abs(nowSeconds - parsedTimestamp) > SIGNATURE_WINDOW_SECONDS) return false
  for (const [seen, expiry] of nonces) {
    if (expiry <= nowSeconds) nonces.delete(seen)
  }
  if (nonces.has(nonce) || nonces.size >= NONCE_LIMIT) return false
  const digest = createHash('sha256').update(body).digest('hex')
  const expected = createHmac('sha256', secret).update(`v1\n${timestamp}\n${nonce}\nPOST\n${operationPath}\n${digest}`).digest()
  const received = Buffer.from(signature, 'hex')
  if (!timingSafeEqual(expected, received)) return false
  nonces.set(nonce, Math.max(nowSeconds, parsedTimestamp) + SIGNATURE_WINDOW_SECONDS)
  return true
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new BodyLimitError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) throw new BodyLimitError()
    chunks.push(Buffer.from(bytes))
  }
  return Buffer.concat(chunks, size)
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

class BodyLimitError extends Error {}
