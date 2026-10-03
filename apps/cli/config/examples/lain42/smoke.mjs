import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const model = 'ci-model'
const key = 'ci-placeholder'
const sourceUrl = 'http://origin.test/article'
const sourceFact = 'LANTERN_COLOR=VIOLET_7319'
const task = `Fetch ${sourceUrl} and report the unique fact stated on that page.`
const llmRequests = []
const proxiedRequests = []
const followUpEvidence = []

const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
    response.writeHead(404).end()
    return
  }
  const payload = JSON.parse(await readBody(request))
  if (request.headers.authorization !== `Bearer ${key}` || payload.model !== model) {
    response.writeHead(400).end('wrong authorization or model')
    return
  }
  llmRequests.push(payload)
  if (llmRequests.length === 1) {
    const prompt = JSON.stringify(payload.messages)
    const schemas = JSON.stringify(payload.tools)
    if (!prompt.includes(task) || !schemas.includes('web_fetch')) {
      response.writeHead(400).end('the first request did not contain the task and web_fetch schema')
      return
    }
    writeStream(response, [
      { delta: { role: 'assistant' } },
      { delta: { tool_calls: [{
        index: 0,
        id: 'call-lain42-fetch',
        type: 'function',
        function: { name: 'web_fetch', arguments: '' },
      }] } },
      { delta: { tool_calls: [{
        index: 0,
        function: { arguments: JSON.stringify({ url: sourceUrl }) },
      }] } },
      { delta: {}, finish_reason: 'tool_calls' },
    ])
    return
  }

  if (llmRequests.length > 8) {
    response.writeHead(400).end('the agent exceeded the smoke request limit')
    return
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const fetchedResult = messages.some(message => message.role === 'tool'
    && JSON.stringify(message.content).includes(sourceFact))
  followUpEvidence.push({
    roles: messages.map(message => message.role),
    fetchedResult,
    tail: messages.slice(-3).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id,
      content: (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).slice(-180),
    })),
  })
  if (fetchedResult) server.sourceReachedModel = true
  writeStream(response, [
    // A request is only allowed to echo the fixture fact after the real web
    // tool result appears in its model-facing message history.
    { delta: { role: 'assistant', content: fetchedResult ? sourceFact : 'SMOKE_FETCH_RESULT_NOT_IN_CONTEXT' } },
    { delta: {}, finish_reason: 'stop' },
  ])
})

const proxy = createServer((request, response) => {
  const target = request.url ?? ''
  proxiedRequests.push(target)
  if (target !== sourceUrl || request.method !== 'GET') {
    response.writeHead(502).end('unexpected proxy request')
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(`The only fact on this page is ${sourceFact}.`)
})

const root = resolve(import.meta.dirname, '../../../../..')
const overlay = resolve(import.meta.dirname, 'cordis.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'lain42-dsh-smoke-'))

try {
  await Promise.all([listen(server), listen(proxy)])
  const modelAddress = server.address()
  const proxyAddress = proxy.address()
  if (!modelAddress || typeof modelAddress === 'string' || !proxyAddress || typeof proxyAddress === 'string') {
    throw new Error('mock services did not bind')
  }
  const overlayContents = await readFile(overlay, 'utf8')
  const smokeOverlayContents = overlayContents.replace(
    '        baseURL: https://api.lain42.top/v1',
    `        baseURL: http://127.0.0.1:${modelAddress.port}/v1`,
  )
  if (smokeOverlayContents === overlayContents) throw new Error('could not prepare the mock gateway overlay')
  const smokeOverlay = join(home, 'lain42-smoke.patch.yml')
  await writeFile(smokeOverlay, smokeOverlayContents)
  const output = await runAgent({
    cwd: root,
    args: ['dsh', '--profile', 'headless', '--patch', smokeOverlay, task],
    env: {
      ...process.env,
      DSH_HOME: home,
      LAIN42_MODEL: model,
      LAIN42_API_KEY: key,
      DSH_TELEMETRY_MODE: 'DISABLED',
      HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
      HTTPS_PROXY: '',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      http_proxy: `http://127.0.0.1:${proxyAddress.port}`,
      https_proxy: '',
      no_proxy: 'localhost,127.0.0.1,::1',
    },
  })

  if (llmRequests.length < 2 || !server.sourceReachedModel || !output.includes(sourceFact)) {
    const evidence = JSON.stringify(followUpEvidence).slice(-1400)
    throw new Error(`the fetched page content did not reach a model request after the web tool result (requests=${llmRequests.length}, fetches=${proxiedRequests.length}, received=${server.sourceReachedModel === true}, followups=${evidence})`)
  }
  if (proxiedRequests.length !== 1 || proxiedRequests[0] !== sourceUrl) {
    throw new Error(`the supplied URL was not fetched exactly once through the fixture proxy: ${proxiedRequests.join(', ')}`)
  }
  process.stdout.write('Lain42 model route and URL-to-model handoff passed\n')
} finally {
  server.closeAllConnections()
  proxy.closeAllConnections()
  await Promise.all([close(server), close(proxy)])
  await rm(home, { recursive: true, force: true })
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function writeStream(response, chunks) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const { delta, finish_reason: finishReason = null } of chunks) {
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-lain42-smoke',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

function listen(serverToStart) {
  return new Promise((resolveListen, rejectListen) => {
    serverToStart.once('error', rejectListen)
    serverToStart.listen(0, '127.0.0.1', () => {
      serverToStart.off('error', rejectListen)
      resolveListen()
    })
  })
}

function close(serverToClose) {
  return new Promise((resolveClose, rejectClose) => {
    serverToClose.close(error => error ? rejectClose(error) : resolveClose())
  })
}

function runAgent({ cwd, args, env }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('pnpm', args, { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => child.kill(), 120_000)
    child.on('error', rejectRun)
    child.on('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolveRun(stdout)
      else rejectRun(new Error(`headless smoke exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}
