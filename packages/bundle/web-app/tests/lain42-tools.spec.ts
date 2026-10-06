import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as lain42Tools from '../src/lain42-tools.ts'

const SECRET = 'test-only-lain42-tool-relay-secret-with-32-bytes'
const RELAY_URL = 'https://api.lain42.top/api/agent/bridge/v1/tool'
const SESSION_ID = brandString<SessionId>('A'.repeat(64))
const agent = { id: SESSION_ID } as NonNullable<ToolRunContext['agent']>

async function createToolContext() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const plugin = await ctx.plugin(lain42Tools)
  return { ctx, dispose: () => plugin.dispose() }
}

function registeredTool(ctx: Context, name: string) {
  const tool = ctx.tools.get(name)
  if (tool === undefined) throw new Error(`Missing test tool: ${name}`)
  return tool
}

function executionContext(
  signal: AbortSignal = new AbortController().signal,
  selectedAgent: ToolRunContext['agent'] | null = agent,
): ToolRunContext {
  return selectedAgent === null ? { signal } as ToolRunContext : { signal, agent: selectedAgent } as ToolRunContext
}

function responseWith(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(
    typeof value === 'string' ? value : JSON.stringify(value),
    { status, ...(headers === undefined ? {} : { headers }) },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseRelayResult(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Expected the tool to return JSON text.')
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) {
    throw new Error('Expected a JSON object from the tool relay.')
  }
  return parsed
}

function readRelayToolName(body: BodyInit | null | undefined): string {
  const text = typeof body === 'string'
    ? body
    : body instanceof Uint8Array
      ? Buffer.from(body).toString('utf8')
      : undefined
  if (text === undefined) throw new Error('Expected a JSON tool request body.')
  const parsed = parseRelayResult(text)
  if (typeof parsed.tool !== 'string') throw new Error('Expected a tool name in the request.')
  return parsed.tool
}

describe('Lain42 account tool relay', () => {
  it('revokes claim previews on stale turns and disposal, and denies incomplete execution identities', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const generation = {}
    const owner = createScope(ctx, generation)
    const session = ctx.sessions.create(SESSION_ID)
    const selectedAgent = { id: SESSION_ID, session } as NonNullable<ToolRunContext['agent']>
    const scope = createScope(ctx, selectedAgent)
    bindScopeParent(selectedAgent, generation)
    Object.assign(selectedAgent, { ctx: scope.ctx })
    const message = createUserMessage({ content: [{ type: 'text', text: 'Public read.' }],
      source: { kind: 'user', rpcId: '11111111-1111-4111-8111-111111111111',
        requestContext: { lain42: { version: 1, toolScope: 'public-only' } } } })
    const guardSpy = vi.spyOn(ToolRuntime.prototype, 'guard')
    try {
      const plugin = await owner.ctx.plugin(lain42Tools)
      const guard = guardSpy.mock.calls[0]?.[0]
      const target = scopeTarget(selectedAgent, selectedAgent)
      ctx.emit(target, 'agent/created', { agent: selectedAgent, source: 'startup' })
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      ctx.emit(target, 'agent/inbox/claimed', { agent: selectedAgent, message, turn: 1 })
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      session.append('turn/start', { turn: 1 })
      ctx.emit(target, 'agent/inbox/claimed', { agent: selectedAgent, message, turn: 1 })
      ctx.emit(target, 'agent/inbox/claimed', { agent: selectedAgent, message, turn: 1 })
      expect(ctx.tools.schemas(selectedAgent).map(tool => tool.name)).toEqual(['lain42_web_search'])
      ctx.emit(target, 'agent/status', { agent: selectedAgent, status: 'running' })
      expect(ctx.tools.schemas(selectedAgent).map(tool => tool.name)).toEqual(['lain42_web_search'])
      if (guard === undefined) throw new Error('Expected the scoped execution guard')
      const exec: ToolExecution = { callId: ToolCallId('incomplete-identity'), rootCallId: ToolCallId('incomplete-identity'),
        token: Symbol('test-execution') as ToolExecutionToken, name: 'lain42_web_search',
        arguments: { query: 'test' }, signal: new AbortController().signal }
      expect(guard(exec)).toBe('The current request does not permit this tool.')
      expect(guard({ ...exec, name: 'unregistered_write', agent: selectedAgent }))
        .toBe('The current request does not permit this tool.')
      expect(guard({ ...exec, name: 'lain42_github_issue', agent: selectedAgent }))
        .toBe('The current request does not permit this tool.')
      session.append('user/message', message, { surfaceOp: 'append' })
      expect(guard({ ...exec, agent: selectedAgent })).toBeUndefined()
      ctx.emit(target, 'agent/inbox/claimed', { agent: selectedAgent, message, turn: 2 })
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      const missingPolicy = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
      try {
        ctx.emit(target, 'agent/inbox/claimed', { agent: selectedAgent, message, turn: 1 })
        expect(ctx.tools.schemas(selectedAgent)).toEqual([])
        expect(guard({ ...exec, agent: selectedAgent })).toBe('The current request does not permit this tool.')
      } finally {
        missingPolicy.mockRestore()
      }
      ctx.emit(target, 'agent/disposed', { agent: selectedAgent })
      ctx.emit(target, 'agent/disposed', { agent: selectedAgent })
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      await plugin.dispose()
      expect(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy')).toBeUndefined()
    } finally {
      guardSpy.mockRestore()
      await scope.dispose()
      await owner.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when a scoped deployment is missing Session projections', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const scope = createScope(ctx, {})
    try {
      await expect(scope.ctx.plugin(lain42Tools)).rejects.toThrow('Scoped Lain42 tools require Session projections')
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await scope.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('fails Agent initialization when its context has no tool runtime', async () => {
    const ctx = new Context()
    const generation = {}
    const scope = createScope(ctx, generation)
    const detached = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjections)
      const plugin = await scope.ctx.plugin(lain42Tools)
      const session = ctx.sessions.create(SESSION_ID)
      const selectedAgent = { id: SESSION_ID, session, ctx: detached } as NonNullable<ToolRunContext['agent']>
      bindScopeParent(selectedAgent, generation)
      await expect(ctx.serial(scopeTarget(selectedAgent, selectedAgent), 'agent/created',
        { agent: selectedAgent, source: 'startup' })).rejects.toThrow('The Agent scope requires a tool runtime')
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      await plugin.dispose()
    } finally {
      await detached.fiber.dispose()
      await scope.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('narrows schemas before assembly, checks direct execution against the committed RPC and removes policy on disposal', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', RELAY_URL)
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    const bodies: Array<Record<string, unknown>> = []
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(parseRelayResult(Buffer.from(init?.body as Uint8Array).toString('utf8')))
      return responseWith({ version: 1, result: { items: [] } })
    })
    vi.stubGlobal('fetch', upstream)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const session = ctx.sessions.create(SESSION_ID)
    session.append('turn/start', { turn: 0 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Bootstrap owned read.' }],
      source: { kind: 'user', rpcId: '00000000-0000-4000-8000-000000000000',
        requestContext: { lain42: { version: 1, toolScope: 'account-read' } } } }), { surfaceOp: 'append' })
    const selectedAgent = { id: SESSION_ID, session } as NonNullable<ToolRunContext['agent']>
    const scope = createScope(ctx, selectedAgent)
    Object.assign(selectedAgent, { ctx: scope.ctx })
    try {
      const plugin = await scope.ctx.plugin(lain42Tools)
      const issue = ctx.tools.get('lain42_github_issue', selectedAgent)
      const search = ctx.tools.get('lain42_web_search', selectedAgent)
      if (issue === undefined || search === undefined) throw new Error('Missing diagnostic relay definitions')
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
      const first = brandString<SessionRequestId>('11111111-1111-4111-8111-111111111111')
      const second = brandString<SessionRequestId>('22222222-2222-4222-8222-222222222222')
      const claim = (turn: number, requestId: SessionRequestId, toolScope: string) => {
        const message = createUserMessage({ content: [{ type: 'text', text: 'Account-read in text grants no permission.' }],
          source: { kind: 'user', rpcId: requestId, requestContext: { lain42: { version: 1, toolScope } } } })
        ctx.emit(scopeTarget(selectedAgent, selectedAgent), 'agent/inbox/claimed', { agent: selectedAgent, message, turn })
        return message
      }
      session.append('turn/start', { turn: 1 })
      const publicMessage = claim(1, first, 'public-only')
      expect(ctx.tools.schemas(selectedAgent).map(tool => tool.name)).toEqual(['lain42_web_search'])
      const exec = executionContext(new AbortController().signal, selectedAgent)
      expect(parseRelayResult(await search.execute({ query: 'public' }, exec))).toHaveProperty('error.code', 'tool_scope_denied')
      expect(upstream).not.toHaveBeenCalled()
      session.append('user/message', publicMessage, { surfaceOp: 'append' })
      expect(parseRelayResult(await issue.execute({ repo: 'owner/project', number: 1 }, exec)))
        .toHaveProperty('error.code', 'tool_scope_denied')
      const denied = await ctx.tools.execute({ callId: ToolCallId('denied-account'), name: 'lain42_github_issue',
        arguments: { repo: 'owner/project', number: 1 }, signal: exec.signal, agent: selectedAgent })
      expect(denied.isError).toBe(true)
      expect(upstream).not.toHaveBeenCalled()
      await search.execute({ query: 'public' }, exec)
      expect(bodies[0]).toMatchObject({ version: 2, request_id: first, tool: 'web_search' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      ctx.emit(scopeTarget(selectedAgent, selectedAgent), 'agent/status', { agent: selectedAgent, status: 'idle' })
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      session.append('turn/start', { turn: 2 })
      session.append('user/message', claim(2, second, 'account-read'), { surfaceOp: 'append' })
      await issue.execute({ repo: 'owner/project', number: 1 }, exec)
      expect(bodies[1]).toMatchObject({ version: 2, request_id: second, tool: 'github_issue' })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 3 })
      session.append('user/message', claim(3, first, 'evidence-only'), { surfaceOp: 'append' })
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      expect(parseRelayResult(await search.execute({ query: 'public' }, exec))).toHaveProperty('error.code', 'tool_scope_denied')
      expect(upstream).toHaveBeenCalledTimes(2)
      await plugin.dispose()
      expect(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy')).toBeUndefined()
      expect(ctx.tools.schemas(selectedAgent)).toEqual([])
      const remounted = await scope.ctx.plugin(lain42Tools)
      expect(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy')).toMatchObject({ toolScope: 'evidence-only' })
      expect(parseRelayResult(await search.execute({ query: 'public' }, exec))).toHaveProperty('error.code', 'tool_scope_denied')
      await remounted.dispose()
      expect(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy')).toBeUndefined()
    } finally {
      await scope.dispose()
      await ctx.fiber.dispose()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('registers only read capabilities and forwards the server-owned DSH session with a body signature', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', 'https://api.lain42.top/api/agent/bridge/v1/tool')
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    let capturedBody = Buffer.alloc(0)
    let capturedHeaders = new Headers()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = Buffer.from(init?.body as Uint8Array)
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({
        version: 1,
        result: { items: [{ full_name: 'lilyco-42/rembg-ui', html_url: 'https://github.com/lilyco-42/rembg-ui' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = await ctx.plugin(lain42Tools)
    try {
      const names = ctx.tools.schemas().map(schema => schema.name).sort()
      expect(names).toEqual([
        'lain42_github_actions_jobs',
        'lain42_github_actions_logs',
        'lain42_github_actions_runs',
        'lain42_github_issue',
        'lain42_github_issues',
        'lain42_github_issues_search',
        'lain42_github_pull_requests',
        'lain42_github_repositories',
        'lain42_github_repositories_search',
        'lain42_web_search',
      ])
      expect(names).not.toContain('lain42_web_fetch')
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('The website account OAuth is used for GitHub')
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Public page reading is client-only')

      const result = await ctx.tools.execute({
        callId: ToolCallId('account-repositories'),
        name: 'lain42_github_repositories',
        arguments: { limit: 4 },
        signal: new AbortController().signal,
        agent,
      })
      expect(result.isError).toBe(false)
      expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('lilyco-42/rembg-ui')

      const payload = JSON.parse(capturedBody.toString('utf8')) as Record<string, unknown>
      expect(payload).toEqual({
        version: 1,
        session_id: SESSION_ID,
        tool: 'github_repositories',
        arguments: { limit: 4 },
      })
      expect(payload).not.toHaveProperty('user_id')
      expect(capturedHeaders.get('x-lain42-signature')).toBe(lain42Tools.signLain42ToolRequest(
        SECRET,
        capturedHeaders.get('x-lain42-timestamp') ?? '',
        capturedHeaders.get('x-lain42-nonce') ?? '',
        capturedBody,
      ))
    } finally {
      await plugin.dispose()
    }
  })

  it('returns a safe actionable result when the relay is unreachable', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', 'https://api.lain42.top/api/agent/bridge/v1/tool')
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private network detail') }))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = await ctx.plugin(lain42Tools)
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('search-1'),
        name: 'lain42_web_search',
        arguments: { query: 'Rust web agent' },
        signal: new AbortController().signal,
        agent,
      })
      const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(result.isError).toBe(false)
      expect(rendered).toContain('tool_relay_unavailable')
      expect(rendered).toContain('temporarily unreachable')
      expect(rendered).not.toContain('private network detail')
    } finally {
      await plugin.dispose()
    }
  })

  it('validates endpoint schemes, loopback exceptions, paths, credentials and URL suffixes', async () => {
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    vi.stubGlobal('fetch', vi.fn(async () => responseWith({ version: 1, result: { ok: true } })))
    const { ctx, dispose } = await createToolContext()
    try {
      const invalidEndpoints = [
        'not a URL',
        'http://example.com/api/agent/bridge/v1/tool',
        'https://api.lain42.top/other',
        'https://user@api.lain42.top/api/agent/bridge/v1/tool',
        'https://:password@api.lain42.top/api/agent/bridge/v1/tool',
        `${RELAY_URL}?debug=1`,
        `${RELAY_URL}#fragment`,
      ]
      for (const endpoint of invalidEndpoints) {
        vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', endpoint)
        const result = await registeredTool(ctx, 'lain42_web_search').execute(
          { query: 'test' }, executionContext(),
        )
        expect(JSON.parse(String(result))).toMatchObject({ error: { code: 'tool_relay_unavailable' } })
      }

      for (const endpoint of [
        'http://127.0.0.1/api/agent/bridge/v1/tool',
        'http://[::1]/api/agent/bridge/v1/tool',
        'http://localhost/api/agent/bridge/v1/tool',
      ]) {
        vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', endpoint)
        const result = await registeredTool(ctx, 'lain42_web_search').execute(
          { query: 'test' }, executionContext(),
        )
        expect(JSON.parse(String(result))).toEqual({ version: 1, result: { ok: true } })
      }
    } finally {
      await dispose()
    }
  })

  it('uses the default endpoint, rejects a short secret and validates the session before sending', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', '')
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    let requestedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return responseWith({ version: 1, result: { ok: true } })
    }))
    const { ctx, dispose } = await createToolContext()
    try {
      const tool = registeredTool(ctx, 'lain42_web_search')
      const defaultResult = await tool.execute({ query: 'test' }, executionContext())
      expect(parseRelayResult(defaultResult)).toEqual({ version: 1, result: { ok: true } })
      expect(requestedUrl).toBe(RELAY_URL)

      delete process.env.LAIN42_DSH_BRIDGE_SECRET
      const missingSecret = await tool.execute({ query: 'test' }, executionContext())
      expect(parseRelayResult(missingSecret)).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', 'short')
      const unconfigured = await tool.execute({ query: 'test' }, executionContext())
      expect(parseRelayResult(unconfigured)).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
      const missingSession = await tool.execute({ query: 'test' }, executionContext(new AbortController().signal, null))
      expect(parseRelayResult(missingSession)).toMatchObject({ error: { code: 'session_unavailable' } })
      const malformedSession = { id: brandString<SessionId>('short') } as NonNullable<ToolRunContext['agent']>
      const invalidSession = await tool.execute({ query: 'test' }, executionContext(new AbortController().signal, malformedSession))
      expect(parseRelayResult(invalidSession)).toMatchObject({ error: { code: 'session_unavailable' } })

      const tooLarge = await tool.execute({ query: 'x'.repeat(33 * 1024) }, executionContext())
      expect(parseRelayResult(tooLarge)).toMatchObject({ error: { code: 'invalid_arguments' } })
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    } finally {
      await dispose()
    }
  })

  it('returns bounded, safe errors for upstream status, oversized bodies and malformed responses', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', RELAY_URL)
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    const { ctx, dispose } = await createToolContext()
    try {
      const tool = registeredTool(ctx, 'lain42_web_search')
      vi.stubGlobal('fetch', vi.fn(async () => responseWith({ message: 'private upstream detail' }, 503)))
      const upstreamFailure = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(upstreamFailure).toMatchObject({ error: { code: 'tool_relay_failed' } })
      expect(JSON.stringify(upstreamFailure)).not.toContain('private upstream detail')

      vi.stubGlobal('fetch', vi.fn(async () => responseWith('not-json')))
      const invalidJson = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(invalidJson).toMatchObject({ error: { code: 'tool_relay_failed' } })

      for (const invalidPayload of [null, [], { version: 2, result: {} }, { version: 1 }]) {
        vi.stubGlobal('fetch', vi.fn(async () => responseWith(invalidPayload)))
        const invalidResponse = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
        expect(invalidResponse).toMatchObject({ error: { code: 'tool_relay_failed' } })
      }

      vi.stubGlobal('fetch', vi.fn(async () => responseWith({ version: 1, error: { code: 'github_not_connected' } })))
      const validError = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(validError).toEqual({ version: 1, error: { code: 'github_not_connected' } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 1, result: { ok: true } }), {
        headers: { 'content-length': 'not-a-number' },
      })))
      const unknownLength = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(unknownLength).toEqual({ version: 1, result: { ok: true } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
        status: 200,
        headers: { 'content-length': String(256 * 1024 + 1) },
      })))
      const declaredTooLarge = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(declaredTooLarge).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1))
          controller.close()
        },
      }))))
      const streamedTooLarge = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(streamedTooLarge).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
      const emptyResponse = parseRelayResult(await tool.execute({ query: 'test' }, executionContext()))
      expect(emptyResponse).toMatchObject({ error: { code: 'tool_relay_failed' } })
    } finally {
      await dispose()
    }
  })

  it('times out the relay and propagates caller cancellation without exposing transport errors', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', RELAY_URL)
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    const { ctx, dispose } = await createToolContext()
    try {
      const tool = registeredTool(ctx, 'lain42_web_search')
      vi.useFakeTimers()
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('transport detail')) }, { once: true })
      })))
      const timeoutRequest = tool.execute({ query: 'test' }, executionContext())
      await vi.advanceTimersByTimeAsync(20_000)
      const timeoutResult = parseRelayResult(await timeoutRequest)
      expect(timeoutResult).toMatchObject({ error: { code: 'tool_relay_unavailable' } })
      expect(JSON.stringify(timeoutResult)).not.toContain('transport detail')

      vi.useRealTimers()
      const controller = new AbortController()
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })))
      const cancelledRequest = tool.execute({ query: 'test' }, executionContext(controller.signal))
      controller.abort(new Error('caller cancelled'))
      await expect(cancelledRequest).rejects.toThrow('cancelled')

      const alreadyCancelled = new AbortController()
      alreadyCancelled.abort(new Error('caller cancelled before start'))
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) return Promise.reject(new Error('pre-cancelled'))
        return Promise.resolve(responseWith({ version: 1, result: { ok: true } }))
      }))
      await expect(tool.execute({ query: 'test' }, executionContext(alreadyCancelled.signal)))
        .rejects.toThrow('pre-cancelled')
    } finally {
      await dispose()
    }
  })

  it('runs every read-only account tool and assembles guidance only when one is visible', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', RELAY_URL)
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    const relayedTools: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const toolName = readRelayToolName(init?.body)
      relayedTools.push(toolName)
      return responseWith({ version: 1, result: { tool: toolName } })
    }))
    const { ctx, dispose } = await createToolContext()
    try {
      const toolArguments: Array<[string, Record<string, unknown>]> = [
        ['lain42_web_search', { query: 'Rust agents' }],
        ['lain42_github_repositories', { limit: 3 }],
        ['lain42_github_repositories_search', { query: 'ast-grep', limit: 3 }],
        ['lain42_github_issue', { repo: 'owner/repo', number: 2 }],
        ['lain42_github_issues', { repo: 'owner/repo', limit: 3 }],
        ['lain42_github_issues_search', { limit: 3 }],
        ['lain42_github_pull_requests', { repo: 'owner/repo', limit: 3 }],
        ['lain42_github_actions_runs', { repo: 'owner/repo', status: 'completed', limit: 5 }],
        ['lain42_github_actions_jobs', { repo: 'owner/repo', run_id: 123, limit: 10 }],
        ['lain42_github_actions_logs', { repo: 'owner/repo', job_id: 456 }],
      ]
      for (const [name, args] of toolArguments) {
        const tool = registeredTool(ctx, name)
        expect(tool.isConcurrencySafe?.(args)).toBe(true)
        const output = parseRelayResult(await tool.execute(args, executionContext()))
        if (!isRecord(output.result)) throw new Error('Expected a tool relay result object.')
        expect(typeof output.result.tool).toBe('string')
      }
      expect(relayedTools).toEqual([
        'web_search', 'github_repositories', 'github_repositories_search',
        'github_issue', 'github_issues', 'github_pull_requests',
        'github_actions_runs', 'github_actions_jobs', 'github_actions_logs',
      ])
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Use the Lain42 read-only tools')
    } finally {
      await dispose()
    }

    const empty = await createToolContext()
    try {
      const getTool = vi.spyOn(empty.ctx.tools, 'get').mockReturnValue(undefined)
      expect(renderPrompt(await empty.ctx.systemPrompt.assemble())).not.toContain('Use the Lain42 read-only tools')
      getTool.mockRestore()
    } finally {
      await empty.dispose()
    }
  })
})
