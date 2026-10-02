/** Exact Issue read, tool continuation and durable replay through the built Web profile. */
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LAIN42_BRIDGE_PATH, signLain42BridgeRequest } from '@deepseek-ai/dsh-web-app/src/lain42-bridge.ts'
import { signLain42ToolRequest } from '@deepseek-ai/dsh-web-app/src/lain42-tools.ts'
import { decompressZstdFrame, scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { withDefaultWeb } from './default-web-process.ts'

const SECRET = 'keyless-lain42-issue-read-composition-secret'
const SESSION = 'b'.repeat(64)
const MODEL = 'composition-model'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const ISSUE_URL = 'https://github.com/owner/project/issues/2'
const ANSWER = `The closed issue still reproduces after a lost response. Persist an export request ID before retrying. Source: ${ISSUE_URL}`

it('returns exact issue evidence to model continuation and replays the recorded answer without rereading', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lain42-issue-composition-'))
  const modelRequests: string[] = []
  const toolRequests: string[] = []
  const signatures: Array<{ actual: string | string[] | undefined; expected: string }> = []
  // Only the external model and account-control-plane HTTP boundaries are replaced.
  const upstream = createServer((incoming, response) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => { body += chunk })
    incoming.once('end', () => {
      if (incoming.url === '/api/agent/bridge/v1/tool') {
        toolRequests.push(body)
        signatures.push({
          actual: incoming.headers['x-lain42-signature'],
          expected: signLain42ToolRequest(SECRET,
            String(incoming.headers['x-lain42-timestamp']), String(incoming.headers['x-lain42-nonce']), Buffer.from(body)),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: 1, result: {
          repo: 'owner/project', items: [{ number: 2, state: 'closed', title: 'Export retry',
            body: 'A reconnect delivers the same export twice.', url: ISSUE_URL }],
          comments: [{ body: 'It still reproduces after a lost response.', author: 'maintainer' }],
          comments_order: 'oldest first', comments_truncated: false,
        } }))
        return
      }
      if (incoming.url !== '/v1/agent/chat/completions') {
        response.writeHead(404).end()
        return
      }
      modelRequests.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = modelRequests.length === 1
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-issue-2', type: 'function',
          function: { name: 'lain42_github_issue', arguments: JSON.stringify({ repo: 'owner/project', number: 2 }) } }] }
        : { role: 'assistant', content: ANSWER }
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta, index: 0, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: modelRequests.length === 1 ? 'tool_calls' : 'stop' }] })}`,
        'data: [DONE]', '',
      ].join('\n\n'))
    })
  })
  test.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      upstream.closeAllConnections()
    })
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Test upstream did not bind')
  const origin = `http://127.0.0.1:${String(address.port)}`
  const patch = join(root, 'lain42-test.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, enableLain42Bridge: true } },
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'lain42-web', model: MODEL } },
    { id: 'llm-pi-ai', config: { providers: { 'lain42-web': {
      api: 'openai-completions', baseURL: `${origin}/v1/agent`, apiKeyEnv: 'LAIN42_COMPOSITION_KEY', models: [{ id: MODEL }],
    } } } },
  ]))
  const options = { patches: [patch], home: join(root, 'home'), cwd: root, env: {
    LAIN42_DSH_BRIDGE_SECRET: SECRET, LAIN42_AGENT_MODEL_RELAY_SECRET: SECRET,
    LAIN42_AGENT_TOOL_RELAY_URL: `${origin}/api/agent/bridge/v1/tool`,
    LAIN42_COMPOSITION_KEY: 'keyless-test-model-only', HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
  } }
  const turn = { version: 1, sessionId: SESSION, requestId: REQUEST, model: MODEL,
    text: `Read ${ISSUE_URL} and propose a fix based on its discussion.` }
  await withDefaultWeb(test, async ({ url }) => {
    expect(await signedTurn(url, turn, test.signal)).toMatchObject({ status: 200, body: { requestId: REQUEST, answer: ANSWER } })
    expect(modelRequests).toHaveLength(2)
    expect(toolRequests).toHaveLength(1)
    expect(JSON.parse(toolRequests[0]!)).toEqual({ version: 1, session_id: SESSION, tool: 'github_issue', arguments: { repo: 'owner/project', number: 2 } })
    expect(signatures[0]?.actual).toBe(signatures[0]?.expected)
    expect(modelRequests[1]).toContain('It still reproduces after a lost response.')
    expect(modelRequests[1]).toContain('closed')
    expect(modelRequests[1]).toContain(ISSUE_URL)
  }, options)

  const sessionRoot = join(options.home, 'sessions')
  const logs = (await readdir(sessionRoot, { recursive: true })).filter(path => path.endsWith('.jsonl.zstd'))
  expect(logs.length).toBeGreaterThan(0)
  const recorded = (await Promise.all(logs.map(async (path) => {
    const bytes = await readFile(join(sessionRoot, path))
    const { frames, tornStart } = scanZstdFrames(bytes)
    expect(tornStart).toBeUndefined()
    return Buffer.concat(await Promise.all(frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end))))).toString('utf8')
  }))).join('\n')
  expect(recorded).toContain('lain42_github_issue')
  expect(recorded).toContain('It still reproduces after a lost response.')
  expect(recorded).toContain(ANSWER)
  await withDefaultWeb(test, async ({ url }) => {
    expect(await signedTurn(url, turn, test.signal)).toMatchObject({ status: 200, body: { requestId: REQUEST, answer: ANSWER } })
    expect(modelRequests).toHaveLength(2)
    expect(toolRequests).toHaveLength(1)
  }, options)
})

function signedTurn(baseUrl: string, value: unknown, signal: AbortSignal): Promise<{ status: number | undefined; body: unknown }> {
  const bytes = Buffer.from(JSON.stringify(value))
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    const pending = request(new URL(LAIN42_BRIDGE_PATH, baseUrl), { method: 'POST', agent: false, signal, headers: {
      'content-type': 'application/json', 'content-length': String(bytes.length),
      'x-lain42-timestamp': timestamp, 'x-lain42-nonce': nonce,
      'x-lain42-signature': signLain42BridgeRequest(SECRET, timestamp, nonce, bytes),
    } }, (response) => {
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
