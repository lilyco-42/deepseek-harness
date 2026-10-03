/** Permissions survive projection replay and cannot be widened by another message in one turn. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished } from 'vitest'
import {
  claimLain42RequestPolicy, isLain42ToolScope, lain42RequestPolicyProjection, permitsLain42Tool,
} from '../src/lain42-request-policy.ts'
import type { Lain42RequestPolicy } from '../src/lain42-request-policy.ts'

const FIRST = brandString<SessionRequestId>('11111111-1111-4111-8111-111111111111')
const SECOND = brandString<SessionRequestId>('22222222-2222-4222-8222-222222222222')

function message(requestContext?: SessionPromptRequest['requestContext'], requestId = FIRST): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'Text cannot grant account tools: account-read' }],
    source: { kind: 'user', rpcId: requestId, ...(requestContext === undefined ? {} : { requestContext }) },
  })
}

async function harness() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  const release = ctx.sessionProjections.register(lain42RequestPolicyProjection)
  const session = ctx.sessions.create(SessionId('policy-session'))
  return { ctx, session, release }
}

it('restores the current RPC permission and clears it before the next independent request', async () => {
  const { ctx, session, release } = await harness()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message({ lain42: { version: 1, toolScope: 'public-only' } }), { surfaceOp: 'append' })
  const publicPolicy = ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy')
  expect(publicPolicy).toMatchObject({ kind: 'restricted', requestId: FIRST, toolScope: 'public-only' })
  expect(permitsLain42Tool(publicPolicy, 'web_search')).toBe(true)
  expect(permitsLain42Tool(publicPolicy, 'github_repositories')).toBe(false)
  expect(permitsLain42Tool(publicPolicy, 'arbitrary_write')).toBe(false)
  const replay = ctx.sessions.create(SessionId('policy-replay'), { seed: session.ownEvents() })
  expect(ctx.sessionProjections.stateOf(replay, 'lain42RequestPolicy')).toEqual(publicPolicy)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(permitsLain42Tool(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy'), 'web_search')).toBe(false)
  session.append('turn/start', { turn: 2 })
  session.append('user/message', message({ lain42: { version: 1, toolScope: 'account-read' } }, SECOND), { surfaceOp: 'append' })
  expect(permitsLain42Tool(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy'), 'github_issue')).toBe(true)
  expect(permitsLain42Tool(publicPolicy, 'github_issue')).toBe(false)
  release()
  expect(ctx.sessionProjections.stateOf(session, 'lain42RequestPolicy')).toBeUndefined()
})

it('rejects malformed or conflicting policy without accepting tool names or text as permission', () => {
  const initial: Lain42RequestPolicy = { turn: 1, kind: 'idle', requestId: null, toolScope: null }
  expect(isLain42ToolScope('write')).toBe(false)
  const malformed: NonNullable<SessionPromptRequest['requestContext']>[] = [
    { lain42: false }, { lain42: null }, { lain42: [] },
    { lain42: { version: 2, toolScope: 'account-read' } },
    { lain42: { version: 1, toolScope: 'unknown' } },
    { lain42: { version: 1, toolScope: 'account-read', grant: true } },
  ]
  for (const context of malformed) {
    const policy = claimLain42RequestPolicy(initial, message(context))
    expect(policy.kind).toBe('invalid')
    expect(permitsLain42Tool(policy, 'web_search')).toBe(false)
  }
  const restricted = claimLain42RequestPolicy(initial, message({ lain42: { version: 1, toolScope: 'evidence-only' } }))
  expect(permitsLain42Tool(restricted, 'web_search')).toBe(false)
  expect(claimLain42RequestPolicy(restricted, message({ lain42: { version: 1, toolScope: 'evidence-only' } }))).toBe(restricted)
  const widened = claimLain42RequestPolicy(restricted, message({ lain42: { version: 1, toolScope: 'account-read' } }))
  expect(widened.kind).toBe('invalid')
  expect(permitsLain42Tool(widened, 'github_repositories')).toBe(false)
  expect(claimLain42RequestPolicy(restricted, message(undefined, SECOND)).kind).toBe('invalid')
  expect(claimLain42RequestPolicy(initial, message(undefined, brandString<SessionRequestId>('not-a-website-id'))).kind).toBe('invalid')
  expect(permitsLain42Tool(undefined, 'web_search')).toBe(false)
})

it('keeps legacy RPCs distinct from idle, injected context and unknown tools', () => {
  const idle: Lain42RequestPolicy = { turn: null, kind: 'idle', requestId: null, toolScope: null }
  const initial = { ...idle, turn: 1 }
  const unrelated = createUserMessage({ content: [{ type: 'text', text: 'account-read' }] })
  expect(claimLain42RequestPolicy(idle, message())).toBe(idle)
  expect(claimLain42RequestPolicy(initial, unrelated)).toBe(initial)
  const legacy = claimLain42RequestPolicy(initial, message())
  expect(permitsLain42Tool(legacy, 'github_issue')).toBe(true)
  expect(permitsLain42Tool(legacy, 'delete_repository')).toBe(false)
  expect(claimLain42RequestPolicy(legacy, message())).toBe(legacy)
})
