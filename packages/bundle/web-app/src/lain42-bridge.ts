/** Private, authenticated turn endpoint for the Lain42 server control plane. */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'

/** Exact server-only path for HMAC-authenticated Lain42 Agent turns. */
export const LAIN42_BRIDGE_PATH = '/lain42/bridge/v1/turn'

const BODY_LIMIT_BYTES = 32 * 1024
const PROMPT_LIMIT_BYTES = 24 * 1024
const SIGNATURE_WINDOW_SECONDS = 60
const TURN_TIMEOUT_MS = 120_000
const FOLLOW_MAX_MESSAGES = 50
const PRESET_ID = 'lain42-web'
const NONCE_LIMIT = 10_000

interface Lain42TurnRequest {
  readonly version: 1
  readonly sessionId: string
  readonly requestId: string
  readonly model?: string
  readonly text: string
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
}

/** Create the authenticated handler used by the route and its wire tests.
 * @param sessionController DSH service that creates, prompts, and follows sessions.
 * @param secret Shared HMAC secret used to authenticate each request.
 * @param logWarning Receives safe diagnostics without request content or secrets.
 * @returns A web route handler for the private turn endpoint.
 */
export function createLain42BridgeHandler(
  sessionController: Pick<SessionController, 'create' | 'selectModel' | 'prompt' | 'follow'>,
  secret: string,
  logWarning: (message: string) => void,
): WebRoute['handler'] {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Lain42 bridge secret must contain at least 32 UTF-8 bytes')
  }
  const nonces = new Map<string, number>()
  return (request, response) => handleTurn(request, response, sessionController, secret, nonces, logWarning)
}

/** Verify a signed request, run the fixed web-safe Session preset, and return its final text. */
async function handleTurn(
  request: IncomingMessage,
  response: ServerResponse,
  sessionController: Pick<SessionController, 'create' | 'selectModel' | 'prompt' | 'follow'>,
  secret: string,
  nonces: Map<string, number>,
  logWarning: (message: string) => void,
): Promise<void> {
  response.setHeader('cache-control', 'no-store')
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return
  }
  if (singleHeader(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    writeJson(response, 415, { error: 'content_type_required' })
    return
  }

  let bytes: Buffer
  try {
    bytes = await readBody(request)
  } catch (error) {
    writeJson(response, error instanceof BodyLimitError ? 413 : 400, { error: 'invalid_request' })
    return
  }
  const timestamp = singleHeader(request, 'x-lain42-timestamp')
  const nonce = singleHeader(request, 'x-lain42-nonce')
  const signature = singleHeader(request, 'x-lain42-signature')
  if (!verifySignature(secret, bytes, timestamp, nonce, signature, nonces)) {
    writeJson(response, 401, { error: 'unauthorized' })
    return
  }
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
  try {
    await sessionController.create({ sessionId, agentPreset: PRESET_ID })
    if (turnRequest.model !== undefined) {
      await sessionController.selectModel({
        sessionId,
        provider: PRESET_ID,
        model: turnRequest.model,
      })
    }
    await sessionController.prompt({
      sessionId,
      requestId,
      mode: 'queue',
      content: [{ type: 'text', text: turnRequest.text }],
    }, controller.signal)
    const result = await collectTurn(sessionController, sessionId, requestId, controller.signal)
    if ('failure' in result) {
      writeJson(response, 502, {
        error: result.failure === 'not-found' ? 'agent_turn_unavailable' : 'agent_turn_failed',
      })
      return
    }
    writeJson(response, 200, { version: 1, requestId: turnRequest.requestId, answer: result.answer })
  } catch (error) {
    const timedOut = controller.signal.reason === timeoutReason
    const status = timedOut ? 504 : 502
    const code = timedOut ? 'agent_turn_timeout' : 'agent_turn_failed'
    logWarning(`Lain42 bridge ${code} (${error instanceof Error ? error.name : 'unknown'})`)
    writeJson(response, status, { error: code })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Follow durable events so retries can recover the result already committed for the same request id. */
async function collectTurn(
  sessionController: Pick<SessionController, 'create' | 'selectModel' | 'prompt' | 'follow'>,
  sessionId: SessionId,
  requestId: SessionRequestId,
  signal: AbortSignal,
): Promise<TurnResult> {
  let currentTurn: number | undefined
  let targetTurn: number | undefined
  let answer: string | undefined
  for await (const frame of sessionController.follow({
    address: { kind: 'session', sessionId },
    maxMessages: FOLLOW_MAX_MESSAGES,
  }, signal)) {
    const events = eventsFromFrame(frame)
    for (const event of events) {
      const data = asRecord(event.data)
      if (data === undefined) continue
      if (event.type === 'turn/start') {
        currentTurn = finiteNumber(data.turn)
      } else if (event.type === 'user/message') {
        const source = asRecord(data.source)
        if (source?.kind === 'user' && source.rpcId === requestId) {
          targetTurn = currentTurn
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
  const requiredKeys = ['requestId', 'sessionId', 'text', 'version']
  if (requiredKeys.some(key => !keys.includes(key))
    || keys.some(key => key !== 'model' && !requiredKeys.includes(key))) return undefined
  if (record.version !== 1 || typeof record.sessionId !== 'string'
    || !/^[A-Za-z0-9]{64}$/.test(record.sessionId)
    || typeof record.requestId !== 'string'
    // New API derives deterministic UUIDv5 IDs from account-scoped message
    // keys so a retry can recover the already completed DSH turn.
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId)
    || typeof record.text !== 'string' || record.text.trim().length === 0
    || Buffer.byteLength(record.text, 'utf8') > PROMPT_LIMIT_BYTES) return undefined
  const model = record.model
  if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model))) return undefined
  return {
    version: 1,
    sessionId: record.sessionId,
    requestId: record.requestId,
    ...(model === undefined ? {} : { model }),
    text: record.text,
  }
}

/** Compute the v1 signature sent by the authenticated New API service.
 * @param secret Shared HMAC secret for the bridge.
 * @param timestamp Unix timestamp in seconds included in the signed headers.
 * @param nonce Unique 128-bit lowercase hexadecimal request nonce.
 * @param body Exact UTF-8 request bytes whose digest is included in the signature.
 * @returns Lowercase hexadecimal HMAC-SHA256 signature.
 */
export function signLain42BridgeRequest(secret: string, timestamp: string, nonce: string, body: Buffer): string {
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  const canonical = `v1\n${timestamp}\n${nonce}\nPOST\n${LAIN42_BRIDGE_PATH}\n${bodyDigest}`
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

function verifySignature(
  secret: string,
  body: Buffer,
  timestamp: string | undefined,
  nonce: string | undefined,
  signature: string | undefined,
  nonces: Map<string, number>,
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
  const expected = Buffer.from(signLain42BridgeRequest(secret, timestamp, nonce, body), 'hex')
  const received = Buffer.from(signature, 'hex')
  if (!timingSafeEqual(expected, received)) return false
  nonces.set(nonce, Math.max(nowSeconds, parsedTimestamp) + SIGNATURE_WINDOW_SECONDS)
  return true
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT_BYTES) throw new BodyLimitError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > BODY_LIMIT_BYTES) throw new BodyLimitError()
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
