import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as lain42Tools from '../src/lain42-tools.ts'

const SECRET = 'test-only-lain42-tool-relay-secret-with-32-bytes'
const SESSION_ID = brandString<SessionId>('A'.repeat(64))

describe('Lain42 account tool relay', () => {
  afterEach(() => {
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
        'lain42_github_issues',
        'lain42_github_pull_requests',
        'lain42_github_repositories',
        'lain42_github_repositories_search',
        'lain42_web_fetch',
        'lain42_web_search',
      ])

      const result = await ctx.tools.execute({
        callId: ToolCallId('account-repositories'),
        name: 'lain42_github_repositories',
        arguments: { limit: 4 },
        signal: new AbortController().signal,
        agent: { id: SESSION_ID },
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
        agent: { id: SESSION_ID },
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
        agent: { id: SESSION_ID },
      })
      const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(result.isError).toBe(false)
      expect(rendered).toContain(pageText)
    } finally {
      await plugin.dispose()
    }
  })
})
