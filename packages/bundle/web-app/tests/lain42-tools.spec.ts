import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as lain42Tools from '../src/lain42-tools.ts'

const SECRET = 'test-only-lain42-tool-relay-secret-with-32-bytes'
const RELAY_URL = 'https://api.lain42.top/api/agent/bridge/v1/tool'
const SESSION_ID = brandString<SessionId>('A'.repeat(64))
const agent = { id: SESSION_ID } as unknown as NonNullable<ToolRunContext['agent']>

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
  return tool as unknown as {
    execute(args: Record<string, unknown>, context: ToolRunContext): Promise<unknown>
    isConcurrencySafe?: () => boolean
  }
}

function executionContext(
  signal: AbortSignal = new AbortController().signal,
  selectedAgent: ToolRunContext['agent'] = agent,
): ToolRunContext {
  return { signal, agent: selectedAgent } as ToolRunContext
}

function responseWith(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers })
}

describe('Lain42 account tool relay', () => {
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
        'lain42_github_issues',
        'lain42_github_pull_requests',
        'lain42_github_repositories',
        'lain42_github_repositories_search',
        'lain42_web_fetch',
        'lain42_web_search',
      ])
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('The website account OAuth is used for GitHub')

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

  it('preserves a bounded non-ASCII page response through the client relay', async () => {
    vi.stubEnv('LAIN42_AGENT_TOOL_RELAY_URL', 'https://api.lain42.top/api/agent/bridge/v1/tool')
    vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
    const pageText = '界'.repeat(50_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 1, result: { text: pageText } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const plugin = await ctx.plugin(lain42Tools)
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('large-page-1'),
        name: 'lain42_web_fetch',
        arguments: { url: 'https://example.com/article' },
        signal: new AbortController().signal,
        agent,
      })
      const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(result.isError).toBe(false)
      expect(rendered).toContain(pageText)
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
      requestedUrl = String(input)
      return responseWith({ version: 1, result: { ok: true } })
    }))
    const { ctx, dispose } = await createToolContext()
    try {
      const tool = registeredTool(ctx, 'lain42_web_search')
      const defaultResult = await tool.execute({ query: 'test' }, executionContext())
      expect(JSON.parse(String(defaultResult))).toEqual({ version: 1, result: { ok: true } })
      expect(requestedUrl).toBe(RELAY_URL)

      vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', 'short')
      const unconfigured = await tool.execute({ query: 'test' }, executionContext())
      expect(JSON.parse(String(unconfigured))).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubEnv('LAIN42_DSH_BRIDGE_SECRET', SECRET)
      const missingSession = await tool.execute({ query: 'test' }, executionContext(new AbortController().signal, undefined))
      expect(JSON.parse(String(missingSession))).toMatchObject({ error: { code: 'session_unavailable' } })
      const malformedSession = { id: 'short' } as unknown as NonNullable<ToolRunContext['agent']>
      const invalidSession = await tool.execute({ query: 'test' }, executionContext(new AbortController().signal, malformedSession))
      expect(JSON.parse(String(invalidSession))).toMatchObject({ error: { code: 'session_unavailable' } })

      const tooLarge = await tool.execute({ query: 'x'.repeat(33 * 1024) }, executionContext())
      expect(JSON.parse(String(tooLarge))).toMatchObject({ error: { code: 'invalid_arguments' } })
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
      const upstreamFailure = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
      expect(upstreamFailure).toMatchObject({ error: { code: 'tool_relay_failed' } })
      expect(JSON.stringify(upstreamFailure)).not.toContain('private upstream detail')

      vi.stubGlobal('fetch', vi.fn(async () => responseWith('not-json')))
      const invalidJson = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
      expect(invalidJson).toMatchObject({ error: { code: 'tool_relay_failed' } })

      for (const invalidPayload of [null, [], { version: 2, result: {} }, { version: 1 }]) {
        vi.stubGlobal('fetch', vi.fn(async () => responseWith(invalidPayload)))
        const invalidResponse = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
        expect(invalidResponse).toMatchObject({ error: { code: 'tool_relay_failed' } })
      }

      vi.stubGlobal('fetch', vi.fn(async () => responseWith({ version: 1, error: { code: 'github_not_connected' } })))
      const validError = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
      expect(validError).toEqual({ version: 1, error: { code: 'github_not_connected' } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 1, result: { ok: true } }), {
        headers: { 'content-length': 'not-a-number' },
      })))
      const unknownLength = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
      expect(unknownLength).toEqual({ version: 1, result: { ok: true } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
        status: 200,
        headers: { 'content-length': String(256 * 1024 + 1) },
      })))
      const declaredTooLarge = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
      expect(declaredTooLarge).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1))
          controller.close()
        },
      }))))
      const streamedTooLarge = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
      expect(streamedTooLarge).toMatchObject({ error: { code: 'tool_relay_unavailable' } })

      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
      const emptyResponse = JSON.parse(String(await tool.execute({ query: 'test' }, executionContext())))
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
        init?.signal?.addEventListener('abort', () => reject(new Error('transport detail')), { once: true })
      })))
      const timeoutRequest = tool.execute({ query: 'test' }, executionContext())
      await vi.advanceTimersByTimeAsync(20_000)
      const timeoutResult = JSON.parse(String(await timeoutRequest))
      expect(timeoutResult).toMatchObject({ error: { code: 'tool_relay_unavailable' } })
      expect(JSON.stringify(timeoutResult)).not.toContain('transport detail')

      vi.useRealTimers()
      const controller = new AbortController()
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
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
      const body = JSON.parse(String(init?.body)) as { tool: string }
      relayedTools.push(body.tool)
      return responseWith({ version: 1, result: { tool: body.tool } })
    }))
    const { ctx, dispose } = await createToolContext()
    try {
      const toolArguments: Array<[string, Record<string, unknown>]> = [
        ['lain42_web_search', { query: 'Rust agents' }],
        ['lain42_web_fetch', { url: 'https://example.com/' }],
        ['lain42_github_repositories', { limit: 3 }],
        ['lain42_github_repositories_search', { query: 'ast-grep', limit: 3 }],
        ['lain42_github_issues', { repo: 'owner/repo', limit: 3 }],
        ['lain42_github_pull_requests', { repo: 'owner/repo', limit: 3 }],
        ['lain42_github_actions_runs', { repo: 'owner/repo', status: 'completed', limit: 5 }],
        ['lain42_github_actions_jobs', { repo: 'owner/repo', run_id: 123, limit: 10 }],
        ['lain42_github_actions_logs', { repo: 'owner/repo', job_id: 456 }],
      ]
      for (const [name, args] of toolArguments) {
        const tool = registeredTool(ctx, name)
        expect(tool.isConcurrencySafe?.()).toBe(true)
        const output = JSON.parse(String(await tool.execute(args, executionContext())))
        expect(output.result.tool).toBeDefined()
      }
      expect(relayedTools).toEqual([
        'web_search', 'web_fetch', 'github_repositories', 'github_repositories_search',
        'github_issues', 'github_pull_requests',
        'github_actions_runs', 'github_actions_jobs', 'github_actions_logs',
      ])
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Use the Lain42 read-only tools')
    } finally {
      await dispose()
    }

    const empty = await createToolContext()
    try {
      const getTool = vi.spyOn(empty.ctx.tools, 'get').mockReturnValue(undefined as never)
      expect(renderPrompt(await empty.ctx.systemPrompt.assemble())).not.toContain('Use the Lain42 read-only tools')
      getTool.mockRestore()
    } finally {
      await empty.dispose()
    }
  })
})
