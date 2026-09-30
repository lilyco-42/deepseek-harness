import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionCreateRequest,
  SessionEventEntry,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPromptRequest,
  SessionRequestId,
  SessionSelectModelRequest,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  createLain42BridgeHandler,
  LAIN42_BRIDGE_PATH,
  registerLain42Bridge,
  signLain42BridgeRequest,
} from '../src/lain42-bridge.ts'

const SECRET = 'test-only-lain42-bridge-secret-with-32-bytes'
const SESSION_ID = brandString<SessionId>('A'.repeat(64))
const REQUEST_ID = brandString<SessionRequestId>('123e4567-e89b-42d3-a456-426614174000')
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

const servers: Server[] = []
let nonceCounter = 0

afterEach(async () => {
  await Promise.all(servers.splice(0).map(active => new Promise<void>((resolve) => {
    active.close(() => { resolve() })
  })))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Lain42 private DSH bridge', () => {
  it('authenticates one bounded prompt, pins the safe preset, returns its answer, and rejects replay', async () => {
    const calls: string[] = []
    const sessionController = {
      create: vi.fn(async (request: SessionCreateRequest) => {
        calls.push('create')
        expect(request).toEqual({ sessionId: SESSION_ID, agentPreset: 'lain42-web-coding' })
        return { sessionId: SESSION_ID, agentPreset: 'lain42-web-coding' }
      }),
      selectModel: vi.fn(async (request: SessionSelectModelRequest) => {
        calls.push('selectModel')
        return { selected: request }
      }),
      prompt: vi.fn(async (request: SessionPromptRequest, _signal: AbortSignal) => {
        calls.push('prompt')
        expect(request).toEqual({
          sessionId: SESSION_ID,
          requestId: REQUEST_ID,
          mode: 'queue',
          content: [{ type: 'text', text: 'What is DeepSeek?' }],
        })
        return { accepted: true as const }
      }),
      follow: vi.fn((_request: SessionFollowRequest, _signal: AbortSignal) => answerEvents()),
    } satisfies Pick<SessionController, 'create' | 'selectModel' | 'prompt' | 'follow'>
    const handler = createLain42BridgeHandler(sessionController, SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const body = Buffer.from(JSON.stringify({
      version: 1,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      model: 'openai/gpt-5.6-sol',
      mode: 'coding',
      text: 'What is DeepSeek?',
    }))
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = '0123456789abcdef0123456789abcdef'
    const headers = signedHeaders(body, timestamp, nonce)

    const result = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, { method: 'POST', headers, body })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      version: 1,
      requestId: REQUEST_ID,
      answer: 'DeepSeek is an AI company and model family.',
    })
    expect(calls).toEqual(['create', 'selectModel', 'prompt'])
    expect(sessionController.selectModel).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      provider: 'lain42-web',
      model: 'openai/gpt-5.6-sol',
      persistDefault: false,
    })
    expect(sessionController.follow).toHaveBeenCalledWith(
      { address: { kind: 'session', sessionId: SESSION_ID }, maxMessages: 50 },
      expect.any(AbortSignal),
    )

    const replay = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, { method: 'POST', headers, body })
    expect(replay.status).toBe(401)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
  })

  it('admits bounded v2 image content through the authenticated Session prompt', async () => {
    const sessionController = {
      create: vi.fn(async (request: SessionCreateRequest) => ({
        sessionId: request.sessionId ?? SESSION_ID,
        agentPreset: request.agentPreset ?? 'general',
      })),
      selectModel: vi.fn(async (request: SessionSelectModelRequest) => ({ selected: request })),
      prompt: vi.fn(async (request: SessionPromptRequest, _signal: AbortSignal) => {
        expect(request).toEqual({
          sessionId: SESSION_ID,
          requestId: REQUEST_ID,
          mode: 'queue',
          content: [
            { type: 'text', text: 'What is in this picture?' },
            { type: 'image', mediaType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
          ],
        })
        return { accepted: true as const }
      }),
      follow: vi.fn((_request: SessionFollowRequest, _signal: AbortSignal) => answerEvents()),
    } satisfies Pick<SessionController, 'create' | 'selectModel' | 'prompt' | 'follow'>
    const handler = createLain42BridgeHandler(sessionController, SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const body = Buffer.from(JSON.stringify({
      version: 2,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      model: 'openai/gpt-5.6-sol',
      mode: 'general',
      text: 'What is in this picture?',
      images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }],
    }))
    const result = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST',
      headers: signedHeaders(
        body,
        String(Math.floor(Date.now() / 1000)),
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
      body,
    })

    expect(result.status).toBe(200)
    expect(sessionController.prompt).toHaveBeenCalledOnce()
  })

  it('admits an image-only v2 turn without adding an empty text block', async () => {
    const sessionController = inactiveSessionController()
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const body = jsonBody({
      version: 2,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      model: 'openai/gpt-5.6-sol',
      mode: 'general',
      text: '',
      images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }],
    })

    const response = await post(baseUrl, body)

    expect(response.status).toBe(200)
    expect(sessionController.prompt).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      mode: 'queue',
      content: [{ type: 'image', mediaType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }],
    }, expect.any(AbortSignal))
  })

  it('rejects malformed or legacy-version image payloads before creating a Session', async () => {
    const sessionController = inactiveSessionController()
    const handler = createLain42BridgeHandler(sessionController, SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const invalid = [
      { version: 1, images: [{ mediaType: 'image/png', data: 'AA==' }] },
      { version: 2, images: null },
      { version: 2, images: [] },
      {
        version: 2,
        images: Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: ONE_PIXEL_PNG_BASE64 })),
      },
      { version: 2, images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }] },
      { version: 2, images: [{ mediaType: 'image/png', data: 'not base64' }] },
      { version: 2, images: [{ mediaType: 'image/png', data: 'AA==', url: 'https://example.com/a.png' }] },
      {
        version: 2,
        images: [
          { mediaType: 'image/png', data: Buffer.alloc(4 * 1024 * 1024).toString('base64') },
          { mediaType: 'image/png', data: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') },
        ],
      },
    ]

    for (const [index, extra] of invalid.entries()) {
      const body = Buffer.from(JSON.stringify({
        version: extra.version,
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        model: 'openai/gpt-5.6-sol',
        text: 'Look at this image',
        images: extra.images,
      }))
      const response = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
        method: 'POST',
        headers: signedHeaders(
          body,
          String(Math.floor(Date.now() / 1000)),
          `${index.toString(16).padStart(2, '0')}${'c'.repeat(30)}`,
        ),
        body,
      })
      expect(response.status).toBe(400)
    }

    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('rejects bad signatures and signed requests with extra fields before creating a Session', async () => {
    const sessionController = inactiveSessionController()
    const handler = createLain42BridgeHandler(sessionController, SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'abcdef0123456789abcdef0123456789'
    const body = Buffer.from(JSON.stringify({
      version: 1,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      text: 'hello',
      cwd: 'C:\\',
    }))
    const invalidSignature = signedHeaders(body, timestamp, nonce)
    invalidSignature['x-lain42-signature'] = '0'.repeat(64)
    const unauthorized = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST', headers: invalidSignature, body,
    })
    expect(unauthorized.status).toBe(401)

    const signedExtraField = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST', headers: signedHeaders(body, timestamp, 'fedcba9876543210fedcba9876543210'), body,
    })
    expect(signedExtraField.status).toBe(400)
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('rejects weak shared secrets at configuration time', () => {
    expect(() => createLain42BridgeHandler(inactiveSessionController(), 'short', vi.fn()))
      .toThrow('at least 32 UTF-8 bytes')
  })

  it('requires the session controller and a 32-byte shared secret before registration', () => {
    expect(() => { registerLain42Bridge(new Context(), SECRET) })
      .toThrow('requires the DSH session-controller service')

    const ctx = new Context()
    ctx.provide('sessionController', inactiveSessionController() as never)
    expect(() => { registerLain42Bridge(ctx, undefined) })
      .toThrow('requires LAIN42_DSH_BRIDGE_SECRET with at least 32 UTF-8 bytes')

    const weakSecretContext = new Context()
    weakSecretContext.provide('sessionController', inactiveSessionController() as never)
    expect(() => { registerLain42Bridge(weakSecretContext, 'short') })
      .toThrow('requires LAIN42_DSH_BRIDGE_SECRET with at least 32 UTF-8 bytes')
  })

  it('returns safe method and content-type errors before reading or creating a Session', async () => {
    const sessionController = inactiveSessionController()
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))

    const method = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`)
    expect(method.status).toBe(405)
    expect(method.headers.get('cache-control')).toBe('no-store')
    expect(await method.json()).toEqual({ error: 'method_not_allowed' })

    const contentType = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST',
      body: '{}',
    })
    expect(contentType.status).toBe(415)
    expect(await contentType.json()).toEqual({ error: 'content_type_required' })
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('bounds declared and streamed bodies and maps stream failures to invalid requests', async () => {
    const handler = createLain42BridgeHandler(inactiveSessionController(), SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const declaredOversize = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(12 * 1024 * 1024 + 1),
    })
    expect(declaredOversize.status).toBe(413)
    expect(await declaredOversize.json()).toEqual({ error: 'invalid_request' })

    const streamedUrl = await listen(handler, (request) => {
      overrideRequestBody(request, Buffer.alloc(12 * 1024 * 1024 + 1))
    })
    const streamedOversize = await fetch(`${streamedUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x',
    })
    expect(streamedOversize.status).toBe(413)
    expect(await streamedOversize.json()).toEqual({ error: 'invalid_request' })

    const failedStreamUrl = await listen(handler, (request) => {
      overrideRequestBody(request, new Error('stream failed'))
    })
    const failedStream = await fetch(`${failedStreamUrl}${LAIN42_BRIDGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x',
    })
    expect(failedStream.status).toBe(400)
    expect(await failedStream.json()).toEqual({ error: 'invalid_request' })

    const noLengthUrl = await listen(handler, (request) => { delete request.headers['content-length'] })
    const noDeclaredLength = await post(noLengthUrl, Buffer.from(JSON.stringify(validRequest())))
    expect(noDeclaredLength.status).toBe(200)
    expect(await noDeclaredLength.json()).toMatchObject({ answer: 'DeepSeek is an AI company and model family.' })
  })

  it('defaults to the general preset and accepts string stream chunks with exact UTF-8 bytes', async () => {
    const sessionController = inactiveSessionController()
    const handler = createLain42BridgeHandler(sessionController, SECRET, vi.fn())
    const baseUrl = await listen(handler, (request) => { request.setEncoding('utf8') })
    const body = Buffer.from(JSON.stringify({ ...validRequest(), text: '你好' }))
    const response = await post(baseUrl, body)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ answer: 'DeepSeek is an AI company and model family.' })
    expect(sessionController.create).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      agentPreset: 'lain42-web',
    })
  })

  it.each([
    ['research', 'lain42-web-research'],
    ['content', 'lain42-web-content'],
  ] as const)('selects the fixed %s preset', async (mode, agentPreset) => {
    const sessionController = inactiveSessionController()
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const response = await post(baseUrl, jsonBody({ ...validRequest(), mode }))

    expect(response.status).toBe(200)
    expect(sessionController.create).toHaveBeenCalledWith({ sessionId: SESSION_ID, agentPreset })
  })

  it('rejects missing, malformed, expired, replayed, and mismatched signatures', async () => {
    const sessionController = inactiveSessionController()
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const body = Buffer.from('{}')
    const timestamp = currentTimestamp()
    const nonce = nextNonce()
    const good = signedHeaders(body, timestamp, nonce)
    const cases: { readonly name: string; readonly headers: Record<string, string> }[] = []
    const missingTimestamp: Record<string, string> = { ...good }
    delete missingTimestamp['x-lain42-timestamp']
    cases.push({ name: 'missing timestamp', headers: missingTimestamp })
    cases.push({ name: 'malformed timestamp', headers: { ...good, 'x-lain42-timestamp': 'not-a-time' } })
    cases.push({ name: 'malformed nonce', headers: { ...good, 'x-lain42-nonce': 'not-a-nonce' } })
    const missingSignature: Record<string, string> = { ...good }
    delete missingSignature['x-lain42-signature']
    cases.push({ name: 'missing signature', headers: missingSignature })
    cases.push({ name: 'malformed signature', headers: { ...good, 'x-lain42-signature': 'z'.repeat(64) } })
    cases.push({ name: 'mismatched signature', headers: { ...good, 'x-lain42-signature': '0'.repeat(64) } })
    cases.push({ name: 'expired timestamp', headers: signedHeaders(body, String(Number(timestamp) - 61), nextNonce()) })
    cases.push({ name: 'future timestamp', headers: signedHeaders(body, String(Number(timestamp) + 120), nextNonce()) })

    for (const { name, headers } of cases) {
      const response = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
        method: 'POST',
        headers,
        body: Uint8Array.from(body),
      })
      expect(response.status, name).toBe(401)
      await response.arrayBuffer()
    }
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('rejects a repeated header value rather than choosing one value', async () => {
    const body = Buffer.from('{}')
    const handler = createLain42BridgeHandler(inactiveSessionController(), SECRET, vi.fn())
    const baseUrl = await listen(handler, (request) => {
      request.headers['x-lain42-timestamp'] = [currentTimestamp(), currentTimestamp()]
    })
    const response = await post(baseUrl, body)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('expires old nonces before accepting a fresh request', async () => {
    const start = Date.now()
    const handler = createLain42BridgeHandler(inactiveSessionController(), SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const body = Buffer.from('{}')
    try {
      expect((await post(baseUrl, body)).status).toBe(400)
      vi.setSystemTime(start + 61_000)
      expect((await post(baseUrl, body)).status).toBe(400)
    } finally {
      vi.setSystemTime(start)
    }
  })

  it('caps retained nonces at the configured request bound', async () => {
    const baseUrl = await listen(createLain42BridgeHandler(inactiveSessionController(), SECRET, vi.fn()))
    const body = Buffer.from('{}')
    const timestamp = currentTimestamp()
    for (let index = 0; index < 10_000; index += 1) {
      const nonce = index.toString(16).padStart(32, '0')
      const response = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
        method: 'POST',
        headers: signedHeaders(body, timestamp, nonce),
        body,
      })
      if (response.status !== 400) throw new Error(`nonce ${index} was not accepted before the limit`)
      await response.arrayBuffer()
    }
    const atLimit = await post(baseUrl, body, timestamp, 'f'.repeat(32))
    expect(atLimit.status).toBe(401)
    expect(await atLimit.json()).toEqual({ error: 'unauthorized' })
  }, 180_000)

  it('rejects malformed JSON, non-object bodies, unknown keys, and invalid request fields', async () => {
    const sessionController = inactiveSessionController()
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const valid = validRequest()
    const missingModel = { ...valid }
    delete missingModel.model
    const cases: Buffer[] = [
      Buffer.from('{'),
      Buffer.from('null'),
      Buffer.from('[]'),
      Buffer.from('7'),
      jsonBody({ ...valid, extra: true }),
      jsonBody(missingModel),
      jsonBody({ version: 1, sessionId: SESSION_ID, requestId: REQUEST_ID, prompt: 'hello' }),
      jsonBody({ ...valid, version: 2 }),
      jsonBody({ ...valid, sessionId: 7 }),
      jsonBody({ ...valid, sessionId: 'invalid' }),
      jsonBody({ ...valid, requestId: 7 }),
      jsonBody({ ...valid, requestId: 'invalid' }),
      jsonBody({ ...valid, text: 7 }),
      jsonBody({ ...valid, text: ' \n ' }),
      jsonBody({ ...valid, text: 'x'.repeat(25 * 1024) }),
      jsonBody({ ...valid, model: 7 }),
      jsonBody({ ...valid, model: 'model with spaces' }),
      jsonBody({ ...valid, mode: 'shell' }),
    ]

    for (const body of cases) {
      const response = await post(baseUrl, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    expect(sessionController.create).not.toHaveBeenCalled()
  })

  it('recovers the completed answer from snapshot records and ignores other turns and non-text blocks', async () => {
    const events = [
      wireEvent('turn/start', 1, { turn: 1 }),
      wireEvent('user/message', 2, { source: { kind: 'tool', rpcId: REQUEST_ID } }),
      wireEvent('user/message', 3, { source: { kind: 'user', rpcId: 'other-request' } }),
      wireEvent('user/message', 4, { source: { kind: 'user', rpcId: REQUEST_ID } }),
      wireEvent('assistant/message', 5, { turn: 2, message: { content: [{ type: 'text', text: 'wrong turn' }] } }),
      wireEvent('assistant/message', 6, { turn: 1, message: null }),
      wireEvent('assistant/message', 7, { turn: 1, message: { content: [{ type: 'image' }, null, [], { type: 'text', text: 9 }] } }),
      wireEvent('assistant/message', 8, { turn: 1, message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }),
      wireEvent('turn/end', 9, { turn: 2, reason: { kind: 'completed' } }),
      wireEvent('turn/end', 10, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const sessionController = inactiveSessionController(() => frames([
      assistantStreamFrame(),
      snapshotFrame(events),
    ]))
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const response = await post(baseUrl, jsonBody(validRequest()))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ answer: 'AB' })
  })

  it('returns unavailable when no matching user turn is present', async () => {
    const sessionController = inactiveSessionController(() => frames([
      assistantStreamFrame(),
      wireFrame('turn/start', { turn: 'invalid' }),
      wireFrame('turn/start', { turn: 1.5 }),
      wireFrame('turn/start', { turn: -1 }),
      wireFrame('other', 7),
      wireFrame('other', null),
      wireFrame('user/message', { source: null }),
      wireFrame('user/message', { source: [] }),
      wireFrame('assistant/message', { turn: 1, message: { content: [] } }),
      wireFrame('turn/end', { turn: 1, reason: null }),
    ]))
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const response = await post(baseUrl, jsonBody(validRequest()))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'agent_turn_unavailable' })
  })

  it('returns a failed-turn response when the durable turn did not complete', async () => {
    const sessionController = inactiveSessionController(() => frames([
      wireFrame('turn/start', { turn: 3 }),
      wireFrame('user/message', { source: { kind: 'user', rpcId: REQUEST_ID } }),
      wireFrame('turn/end', { turn: 3, reason: { kind: 'failed' } }),
    ]))
    const baseUrl = await listen(createLain42BridgeHandler(sessionController, SECRET, vi.fn()))
    const response = await post(baseUrl, jsonBody(validRequest()))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'agent_turn_failed' })

    const completedWithoutAnswer = inactiveSessionController(() => frames([
      wireFrame('turn/start', { turn: 4 }),
      wireFrame('user/message', { source: { kind: 'user', rpcId: REQUEST_ID } }),
      wireFrame('turn/end', { turn: 4, reason: { kind: 'completed' } }),
    ]))
    const completedUrl = await listen(createLain42BridgeHandler(completedWithoutAnswer, SECRET, vi.fn()))
    const completed = await post(completedUrl, jsonBody(validRequest()))
    expect(completed.status).toBe(502)
    expect(await completed.json()).toEqual({ error: 'agent_turn_failed' })
  })

  it('maps session failures to safe diagnostics and times out stalled turns', async () => {
    const warning = vi.fn()
    const rejectedController = inactiveSessionController()
    rejectedController.create = vi.fn(async () => { throw new Error('private upstream detail') })
    const rejectedUrl = await listen(createLain42BridgeHandler(rejectedController, SECRET, warning))
    const rejected = await post(rejectedUrl, jsonBody(validRequest()))
    expect(rejected.status).toBe(502)
    expect(await rejected.json()).toEqual({ error: 'agent_turn_failed' })
    expect(warning).toHaveBeenCalledWith('Lain42 bridge agent_turn_failed (Error)')

    const nonErrorWarning = vi.fn()
    const nonErrorController = inactiveSessionController()
    nonErrorController.create = vi.fn(async () => {
      throw { reason: 'private upstream detail' }
    })
    const nonErrorUrl = await listen(createLain42BridgeHandler(nonErrorController, SECRET, nonErrorWarning))
    const nonError = await post(nonErrorUrl, jsonBody(validRequest()))
    expect(nonError.status).toBe(502)
    expect(nonErrorWarning).toHaveBeenCalledWith('Lain42 bridge agent_turn_failed (unknown)')

    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 120_000 && typeof callback === 'function') callback(...args)
      return realSetTimeout(callback, delay, ...args)
    })
    const timeoutController = inactiveSessionController(async function* (signal) {
      if (signal.aborted) throw signal.reason
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
      })
    })
    const timeoutWarning = vi.fn()
    const timeoutUrl = await listen(createLain42BridgeHandler(timeoutController, SECRET, timeoutWarning))
    const timedOut = await post(timeoutUrl, jsonBody(validRequest()))
    expect(timedOut.status).toBe(504)
    expect(await timedOut.json()).toEqual({ error: 'agent_turn_timeout' })
    expect(timeoutWarning).toHaveBeenCalledWith('Lain42 bridge agent_turn_timeout (Error)')
  })

  it('logs registration failures without exposing their private error text', async () => {
    const ctx = new Context()
    let route: WebRoute | undefined
    const registration = vi.fn((value: WebRoute) => {
      route = value
      return () => {}
    })
    ctx.provide('webServer', { register: registration } as never)
    const sessionController = inactiveSessionController()
    sessionController.create = vi.fn(async () => { throw new Error('secret detail') })
    ctx.provide('sessionController', sessionController as never)
    const warning = vi.spyOn(ctx.logger, 'warn')
    const plugin = ctx.plugin((bridgeCtx: Context) => { registerLain42Bridge(bridgeCtx, SECRET) })
    await plugin
    expect(registration).toHaveBeenCalledOnce()
    expect(route?.path).toBe(LAIN42_BRIDGE_PATH)

    const baseUrl = await listen(route!.handler)
    const response = await post(baseUrl, jsonBody(validRequest()))
    expect(response.status).toBe(502)
    expect(warning).toHaveBeenCalledWith('Lain42 bridge agent_turn_failed (Error)')
    await plugin.dispose()
  })
})

async function* answerEvents(): AsyncGenerator<SessionFollowFrame> {
  yield { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }
  yield {
    type: 'event',
    event: {
      type: 'user/message', seq: 2, time: 2, surfaceOp: 'append',
      data: { source: { kind: 'user', rpcId: REQUEST_ID }, content: [{ type: 'text', text: 'What is DeepSeek?' }] },
    },
  }
  yield {
    type: 'event',
    event: {
      type: 'assistant/message', seq: 3, time: 3, surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'DeepSeek is an AI company and model family.' }] },
      },
    },
  }
  yield {
    type: 'event',
    event: { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  }
}

function inactiveSessionController(
  followFrames: (signal: AbortSignal) => AsyncGenerator<SessionFollowFrame> = () => answerEvents(),
): Pick<SessionController, 'create' | 'selectModel' | 'prompt' | 'follow'> {
  return {
    create: vi.fn(async (_request: SessionCreateRequest) => ({ sessionId: SESSION_ID })),
    selectModel: vi.fn(async (request: SessionSelectModelRequest) => ({ selected: request })),
    prompt: vi.fn(async (_request: SessionPromptRequest, _signal: AbortSignal) => ({ accepted: true as const })),
    follow: vi.fn((_request: SessionFollowRequest, signal: AbortSignal) => followFrames(signal)),
  }
}

function validRequest(): Record<string, unknown> {
  return {
    version: 1,
    sessionId: SESSION_ID,
    requestId: REQUEST_ID,
    model: 'openai/gpt-5.6-sol',
    text: 'hello',
  }
}

function jsonBody(value: object): Buffer {
  return Buffer.from(JSON.stringify(value) ?? '')
}

function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1000))
}

function nextNonce(): string {
  nonceCounter += 1
  return nonceCounter.toString(16).padStart(32, '0')
}

async function post(baseUrl: string, body: Buffer, timestamp = currentTimestamp(), nonce = nextNonce()): Promise<Response> {
  return fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, {
    method: 'POST',
    headers: signedHeaders(body, timestamp, nonce),
    body: Uint8Array.from(body),
  })
}

function wireEvent(type: string, seq: number, data: SessionWireEvent['data']): SessionWireEvent {
  return { type, seq, time: seq, data }
}

function wireFrame(type: string, data: SessionWireEvent['data']): SessionFollowFrame {
  return { type: 'event', event: wireEvent(type, 1, data) }
}

async function* frames(values: readonly SessionFollowFrame[]): AsyncGenerator<SessionFollowFrame> {
  yield* values
}

function snapshotFrame(events: readonly SessionWireEvent[]): SessionFollowFrame {
  return {
    type: 'snapshot',
    header: { version: 1, id: SESSION_ID, createdAt: 1, isSeeded: false },
    cursor: events.at(-1)?.seq ?? 0,
    records: events.map((event): SessionEventEntry => ({ type: 'event', event })),
    hasMore: false,
    projections: { asOfSeq: events.at(-1)?.seq ?? 0, values: {} },
  }
}

function assistantStreamFrame(): SessionFollowFrame {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'start',
      attemptId: brandString<LlmAttemptId>('test-attempt'),
      revision: 0,
      startedAfterSeq: -1,
      turn: 1,
      step: 1,
    },
  }
}

function overrideRequestBody(request: IncomingMessage, body: string | Buffer | Error): void {
  Object.defineProperty(request, Symbol.asyncIterator, {
    value: async function* () {
      if (body instanceof Error) throw body
      yield body
    },
  })
}

function signedHeaders(body: Buffer, timestamp: string, nonce: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-lain42-timestamp': timestamp,
    'x-lain42-nonce': nonce,
    'x-lain42-signature': signLain42BridgeRequest(SECRET, timestamp, nonce, body),
  }
}

async function listen(
  handler: ReturnType<typeof createLain42BridgeHandler>,
  prepareRequest: (request: IncomingMessage) => void = () => {},
): Promise<string> {
  const active = createServer((request, response) => {
    prepareRequest(request)
    void handler(request, response)
  })
  servers.push(active)
  await new Promise<void>((resolve, reject) => {
    active.once('error', reject)
    active.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = active.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}
