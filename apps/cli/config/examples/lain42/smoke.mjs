import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const model = 'ci-model'
const key = 'ci-placeholder'
const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
    response.writeHead(404).end()
    return
  }
  const body = await new Promise((resolveBody, rejectBody) => {
    let data = ''
    request.on('data', chunk => { data += chunk })
    request.on('end', () => resolveBody(data))
    request.on('error', rejectBody)
  })
  const payload = JSON.parse(body)
  if (request.headers.authorization !== `Bearer ${key}` || payload.model !== model) {
    response.writeHead(400).end('wrong authorization or model')
    return
  }
  server.receivedValidRequest = true
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-lain42-smoke', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'LAIN42_SMOKE_OK' }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-lain42-smoke', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`)
  response.end('data: [DONE]\n\n')
})

const root = resolve(import.meta.dirname, '../../../../..')
const overlay = resolve(import.meta.dirname, 'cordis.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'lain42-dsh-smoke-'))
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock gateway did not bind')
  const output = await new Promise((resolveRun, rejectRun) => {
    const child = spawn('pnpm', ['dsh', '--profile', 'headless', '--patch', overlay, 'Reply with the test result.'], {
      cwd: root,
      env: {
        ...process.env,
        DSH_HOME: home,
        LAIN42_MODEL: model,
        LAIN42_API_KEY: key,
        LAIN42_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
    })
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
  if (!server.receivedValidRequest || !output.includes('LAIN42_SMOKE_OK')) {
    throw new Error('the Lain42 route did not return its mocked response')
  }
  process.stdout.write('Lain42 headless model route smoke passed\n')
} finally {
  server.close()
  await rm(home, { recursive: true, force: true })
}
