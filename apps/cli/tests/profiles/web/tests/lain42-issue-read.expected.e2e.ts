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
const PUBLIC_REQUEST = '33333333-3333-4333-8333-333333333333'
const EVIDENCE_REQUEST = '55555555-5555-4555-8555-555555555555'
const ISSUE_URL = 'https://github.com/owner/project/issues/2'
const PUBLIC_URL = 'https://github.com/ast-grep/ast-grep'
const PUBLIC_ANSWER = `The official repository is ast-grep/ast-grep. Source: ${PUBLIC_URL}`
const EVIDENCE_ANSWER = 'The supplied note says revision seven; no additional lookup was needed.'
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
        const tool = JSON.parse(body) as { tool: string }
        response.end(JSON.stringify({ version: 1, result: tool.tool === 'web_search'
          ? { items: [{ title: 'ast-grep', url: PUBLIC_URL, snippet: 'Official structural search repository.' }] }
          : {
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
      const step = modelRequests.length
      const toolName = step === 1 || step === 4 ? 'lain42_github_issue'
        : step === 2 || step === 6 ? 'lain42_web_search' : undefined
      const delta = toolName === undefined
        ? { role: 'assistant', content: step === 3 ? PUBLIC_ANSWER : step === 5 ? ANSWER : EVIDENCE_ANSWER }
        : { role: 'assistant', tool_calls: [{ index: 0, id: `read-${String(step)}`, type: 'function',
          function: { name: toolName, arguments: JSON.stringify(toolName === 'lain42_web_search'
            ? { query: 'ast-grep official repository' } : { repo: 'owner/project', number: 2 }) } }] }
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta, index: 0, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: toolName === undefined ? 'stop' : 'tool_calls' }] })}`,
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
  const turn = { version: 3, toolScope: 'account-read', sessionId: SESSION, requestId: REQUEST, model: MODEL,
    text: `Read ${ISSUE_URL} and propose a fix based on its discussion.` }
  const publicTurn = { ...turn, requestId: PUBLIC_REQUEST, toolScope: 'public-only',
    text: 'Search the public web for the official ast-grep repository. Do not access my account.' }
  const evidenceTurn = { ...turn, requestId: EVIDENCE_REQUEST, toolScope: 'evidence-only',
    text: 'Explain only this supplied note: revision seven. Do not search or read my account.' }
  await withDefaultWeb(test, async ({ url }) => {
    expect(await signedTurn(url, publicTurn, test.signal)).toMatchObject({ status: 200,
      body: { requestId: PUBLIC_REQUEST, answer: PUBLIC_ANSWER } })
    expect(modelRequests).toHaveLength(3)
    expect(toolRequests).toHaveLength(1)
    expect(JSON.parse(toolRequests[0]!)).toEqual({ version: 2, session_id: SESSION,
      request_id: PUBLIC_REQUEST, tool: 'web_search', arguments: { query: 'ast-grep official repository' } })
    for (const requestBody of modelRequests) {
      const modelRequest = JSON.parse(requestBody) as { tools: Array<{ function: { name: string } }> }
      expect(modelRequest.tools.map(tool => tool.function.name)).toEqual(['lain42_web_search'])
    }
    expect((JSON.parse(modelRequests[1]!) as { messages: unknown[] }).messages).toContainEqual({
      role: 'tool', tool_call_id: 'read-1', content: 'Error: The current request does not permit this tool.',
    })
    expect(modelRequests[2]).toContain(PUBLIC_URL)
    expect(await signedTurn(url, { ...publicTurn, toolScope: 'account-read' }, test.signal)).toMatchObject({ status: 409 })
    expect(toolRequests).toHaveLength(1)
    expect(modelRequests).toHaveLength(3)
    expect(await signedTurn(url, turn, test.signal)).toMatchObject({ status: 200, body: { requestId: REQUEST, answer: ANSWER } })
    expect(modelRequests).toHaveLength(5)
    expect(toolRequests).toHaveLength(2)
    expect(JSON.parse(toolRequests[1]!)).toEqual({ version: 2, session_id: SESSION, request_id: REQUEST,
      tool: 'github_issue', arguments: { repo: 'owner/project', number: 2 } })
    expect(signatures[0]?.actual).toBe(signatures[0]?.expected)
    expect(signatures[1]?.actual).toBe(signatures[1]?.expected)
    expect(modelRequests[4]).toContain('It still reproduces after a lost response.')
    expect(modelRequests[4]).toContain('closed')
    expect(modelRequests[4]).toContain(ISSUE_URL)
    expect(await signedTurn(url, evidenceTurn, test.signal)).toMatchObject({ status: 200,
      body: { requestId: EVIDENCE_REQUEST, answer: EVIDENCE_ANSWER } })
    expect(modelRequests).toHaveLength(7)
    expect(toolRequests).toHaveLength(2)
    for (const requestBody of modelRequests.slice(5)) {
      const modelRequest = JSON.parse(requestBody) as { tools?: unknown[] }
      expect(modelRequest.tools ?? []).toEqual([])
    }
    expect((JSON.parse(modelRequests[6]!) as { messages: unknown[] }).messages).toContainEqual({
      role: 'tool', tool_call_id: 'read-6', content: 'Error: The current request does not permit this tool.',
    })
    // Read while the process is still alive: disposal must not provide the barrier.
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
    expect(recorded).toContain('public-only')
    expect(recorded).toContain('evidence-only')
    expect(recorded).toContain('account-read')
  }, options)

  await withDefaultWeb(test, async ({ url }) => {
    expect(await signedTurn(url, turn, test.signal)).toMatchObject({ status: 200, body: { requestId: REQUEST, answer: ANSWER } })
    expect(await signedTurn(url, publicTurn, test.signal)).toMatchObject({ status: 200,
      body: { requestId: PUBLIC_REQUEST, answer: PUBLIC_ANSWER } })
    expect(await signedTurn(url, evidenceTurn, test.signal)).toMatchObject({ status: 200,
      body: { requestId: EVIDENCE_REQUEST, answer: EVIDENCE_ANSWER } })
    expect(await signedTurn(url, { ...publicTurn, toolScope: 'account-read' }, test.signal)).toMatchObject({ status: 409 })
    expect(modelRequests).toHaveLength(7)
    expect(toolRequests).toHaveLength(2)
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
