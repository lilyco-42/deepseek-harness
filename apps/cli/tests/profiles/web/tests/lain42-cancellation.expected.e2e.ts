/** Signed Stop through the built Web profile, real Inbox and JSONL recovery. */
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  LAIN42_BRIDGE_PATH,
  LAIN42_CANCEL_PATH,
  signLain42BridgeRequest,
} from '@deepseek-ai/dsh-web-app/src/lain42-bridge.ts'
import { signLain42AgentModelRelayRequest } from '@deepseek-ai/dsh-web-app/src/lain42-model-relay.ts'
import { decompressZstdFrame, scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { withDefaultWeb } from './default-web-process.ts'

const SECRET = 'keyless-lain42-cancellation-composition-secret'
const SESSION = 'a'.repeat(64)
const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const MODEL = 'composition-model'

it('settles an original Stop, protects a newer turn and never re-executes it after process restart', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lain42-stop-composition-'))
  const firstInference = Promise.withResolvers<undefined>()
  const firstClosed = Promise.withResolvers<undefined>()
  const secondInference = Promise.withResolvers<ServerResponse>()
  const calls: Array<{ path: string | undefined; headers: Record<string, string | string[] | undefined>; body: unknown }> = []
  const responses: ServerResponse[] = []
  // Only the external model HTTP service is replaced. The real pi-ai adapter,
  // Loader, SessionController, Agent Inbox and durable JSONL store remain loaded.
  const modelServer = createServer((incoming, response) => {
    responses.push(response)
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => { body += chunk })
    incoming.once('end', () => {
      const parsed: unknown = JSON.parse(body)
      calls.push({ path: incoming.url, headers: incoming.headers, body: parsed })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}\n\n')
      if (calls.length === 1) {
        response.once('close', () => { firstClosed.resolve(undefined) })
        firstInference.resolve(undefined)
      } else if (calls.length === 2) {
        secondInference.resolve(response)
      } else {
        response.end('data: [DONE]\n\n')
      }
    })
  })
  test.onTestFinished(async () => {
    for (const response of responses) response.destroy()
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      modelServer.closeAllConnections()
    })
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    modelServer.once('error', reject)
    modelServer.listen(0, '127.0.0.1', resolve)
  })
  const address = modelServer.address()
  if (address === null || typeof address === 'string') throw new Error('Model server did not bind')
  const patch = join(root, 'lain42-test.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: true, enableLain42Bridge: true } },
    // Automatic title inference is independent of prompt cancellation.
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'lain42-web', model: MODEL } },
    { id: 'llm-pi-ai', config: { providers: {
      'lain42-web': {
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${String(address.port)}/v1/agent`,
        apiKeyEnv: 'LAIN42_COMPOSITION_KEY',
        models: [{ id: MODEL }],
      },
    } } },
  ]))
  const options = {
    patches: [patch],
    home: join(root, 'home'),
    cwd: root,
    env: {
      LAIN42_DSH_BRIDGE_SECRET: SECRET,
      LAIN42_AGENT_MODEL_RELAY_SECRET: SECRET,
      LAIN42_COMPOSITION_KEY: 'keyless-test-model-only',
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
    },
  }
  const turn = { version: 1, sessionId: SESSION, requestId: FIRST, model: MODEL, text: 'Cancel this original task.' }
  await withDefaultWeb(test, async ({ url }) => {
    const denied = await signedPost(url, LAIN42_CANCEL_PATH, { version: 1, sessionId: SESSION, requestId: FIRST }, test.signal, 'invalid-secret')
    expect(denied.status).toBe(401)
    expect(calls).toEqual([])
    const original = signedPost(url, LAIN42_BRIDGE_PATH, turn, test.signal)
    await Promise.race([
      firstInference.promise,
      original.then((reply) => { throw new Error(`Original turn ended before inference: ${JSON.stringify(reply)}`) }),
    ])
    expect(calls[0]?.path).toBe('/v1/agent/chat/completions')
    const headers = calls[0]!.headers
    expect(headers['x-lain42-agent-session']).toBe(SESSION)
    expect(headers['x-lain42-signature']).toBe(signLain42AgentModelRelayRequest(
      SECRET, String(headers['x-lain42-timestamp']), String(headers['x-lain42-nonce']), SESSION, MODEL,
    ))
    const canceled = await signedPost(url, LAIN42_CANCEL_PATH, { version: 1, sessionId: SESSION, requestId: FIRST }, test.signal)
    expect(canceled.status).toBe(200)
    expect(canceled.body).toMatchObject({ version: 1, sessionId: SESSION, requestId: FIRST, status: 'cancellation-requested', turn: 1 })
    await firstClosed.promise
    expect(await original).toMatchObject({ status: 502, body: { error: 'agent_turn_failed' } })

    const newer = signedPost(url, LAIN42_BRIDGE_PATH, { ...turn, requestId: SECOND, text: 'Answer this newer task.' }, test.signal)
    const response = await Promise.race([
      secondInference.promise,
      newer.then((reply) => { throw new Error(`New turn ended before inference: ${JSON.stringify(reply)}`) }),
    ])
    const oldStop = await signedPost(url, LAIN42_CANCEL_PATH, { version: 1, sessionId: SESSION, requestId: FIRST }, test.signal)
    expect(oldStop.body).toMatchObject({ requestId: FIRST, status: 'not-active' })
    expect(response.destroyed).toBe(false)
    response.end([
      'data: {"choices":[{"delta":{"content":"New task completed."},"index":0,"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'))
    expect(await newer).toMatchObject({ status: 200, body: { requestId: SECOND, answer: 'New task completed.' } })
    expect(await signedPost(url, LAIN42_BRIDGE_PATH, turn, test.signal))
      .toMatchObject({ status: 502, body: { error: 'agent_turn_failed' } })
    expect(calls).toHaveLength(2)
  }, options)

  const sessionRoot = join(options.home, 'sessions')
  const logs = (await readdir(sessionRoot, { recursive: true })).filter(path => path.endsWith('.jsonl.zstd'))
  expect(logs.length).toBeGreaterThan(0)
  const records = (await Promise.all(logs.map(async (path) => {
    const bytes = await readFile(join(sessionRoot, path))
    const { frames, tornStart } = scanZstdFrames(bytes)
    expect(tornStart).toBeUndefined()
    return Buffer.concat(await Promise.all(frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end)))))
      .toString('utf8')
  })))
    .flatMap(text => text.trim().split('\n').map((line): unknown => JSON.parse(line)))
  const originalEnd = records.find(record => typeof record === 'object' && record !== null
    && 'type' in record && record.type === 'turn/end'
    && 'data' in record && typeof record.data === 'object' && record.data !== null
    && 'turn' in record.data && record.data.turn === 1)
  expect(originalEnd).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await withDefaultWeb(test, async ({ url }) => {
    expect(await signedPost(url, LAIN42_BRIDGE_PATH, turn, test.signal))
      .toMatchObject({ status: 502, body: { error: 'agent_turn_failed' } })
    expect(calls).toHaveLength(2)
    const completedReplay = await signedPost(url, LAIN42_BRIDGE_PATH, { ...turn, requestId: SECOND, text: 'Answer this newer task.' }, test.signal)
    expect(completedReplay).toMatchObject({ status: 200, body: { requestId: SECOND, answer: 'New task completed.' } })
    expect(calls).toHaveLength(2)
  }, options)
})

/** Send to this test's loopback process without inheriting a global proxy dispatcher. */
function signedPost(
  baseUrl: string,
  path: typeof LAIN42_BRIDGE_PATH | typeof LAIN42_CANCEL_PATH,
  value: unknown,
  signal: AbortSignal,
  secret = SECRET,
): Promise<{ status: number | undefined; body: unknown }> {
  const bytes = Buffer.from(JSON.stringify(value))
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    const pending = request(new URL(path, baseUrl), {
      method: 'POST', agent: false, signal,
      headers: {
        'content-type': 'application/json',
        'content-length': String(bytes.length),
        'x-lain42-timestamp': timestamp,
        'x-lain42-nonce': nonce,
        'x-lain42-signature': signLain42BridgeRequest(secret, timestamp, nonce, bytes, path),
      },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.once('error', reject)
      response.once('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }) }
        catch (error) { reject(error instanceof Error ? error : new Error('Invalid JSON from private bridge', { cause: error })) }
      })
    })
    pending.once('error', reject)
    pending.end(bytes)
  })
}
