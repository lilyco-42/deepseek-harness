import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionCreateRequest,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  createLain42BridgeHandler,
  LAIN42_BRIDGE_PATH,
  signLain42BridgeRequest,
} from '../src/lain42-bridge.ts'

const SECRET = 'test-only-lain42-bridge-secret-with-32-bytes'
const SESSION_ID = brandString<SessionId>('A'.repeat(64))
const REQUEST_ID = brandString<SessionRequestId>('123e4567-e89b-42d3-a456-426614174000')

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

describe('Lain42 private DSH bridge', () => {
  it('authenticates one bounded prompt, pins the safe preset, returns its answer, and rejects replay', async () => {
    const calls: string[] = []
    const sessionController = {
      create: vi.fn(async (request: SessionCreateRequest) => {
        calls.push('create')
        expect(request).toEqual({ sessionId: SESSION_ID, agentPreset: 'lain42-web' })
        return { sessionId: SESSION_ID, agentPreset: 'lain42-web' }
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
    } satisfies Pick<SessionController, 'create' | 'prompt' | 'follow'>
    const handler = createLain42BridgeHandler(sessionController, SECRET, vi.fn())
    const baseUrl = await listen(handler)
    const body = Buffer.from(JSON.stringify({
      version: 1,
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
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
    expect(calls).toEqual(['create', 'prompt'])
    expect(sessionController.follow).toHaveBeenCalledWith(
      { address: { kind: 'session', sessionId: SESSION_ID }, maxMessages: 50 },
      expect.any(AbortSignal),
    )

    const replay = await fetch(`${baseUrl}${LAIN42_BRIDGE_PATH}`, { method: 'POST', headers, body })
    expect(replay.status).toBe(401)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
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

function inactiveSessionController(): Pick<SessionController, 'create' | 'prompt' | 'follow'> {
  return {
    create: vi.fn(async (_request: SessionCreateRequest) => ({ sessionId: SESSION_ID })),
    prompt: vi.fn(async (_request: SessionPromptRequest, _signal: AbortSignal) => ({ accepted: true as const })),
    follow: vi.fn(async function* (_request: SessionFollowRequest, _signal: AbortSignal) {
      yield* answerEvents()
    }),
  }
}

function signedHeaders(body: Buffer, timestamp: string, nonce: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-lain42-timestamp': timestamp,
    'x-lain42-nonce': nonce,
    'x-lain42-signature': signLain42BridgeRequest(SECRET, timestamp, nonce, body),
  }
}

async function listen(handler: ReturnType<typeof createLain42BridgeHandler>): Promise<string> {
  const active = createServer((request, response) => { void handler(request, response) })
  server = active
  await new Promise<void>((resolve, reject) => {
    active.once('error', reject)
    active.listen(0, '127.0.0.1', () => resolve())
  })
  const address = active.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}
