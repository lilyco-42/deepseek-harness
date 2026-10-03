/** Exact active website request permissions derived from committed Session events. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Read permissions supplied by the signed website request, never by tool arguments. */
export type Lain42ToolScope = 'public-only' | 'evidence-only' | 'account-read'

/** Host-only projection of the exact request in an open turn. */
export interface Lain42RequestPolicy {
  readonly turn: number | null
  readonly kind: 'idle' | 'legacy' | 'restricted' | 'invalid'
  readonly requestId: SessionRequestId | null
  readonly toolScope: Lain42ToolScope | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Current website request identity and permission; absent between turns. */
    lain42RequestPolicy: Lain42RequestPolicy
  }
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const RELAY_TOOLS = new Set([
  'web_search', 'github_repositories', 'github_repositories_search', 'github_issue',
  'github_issues', 'github_pull_requests', 'github_actions_runs', 'github_actions_jobs', 'github_actions_logs',
])
const IDLE: Lain42RequestPolicy = { turn: null, kind: 'idle', requestId: null, toolScope: null }

/**
 * Recognize the signed website protocol's closed read-permission set.
 * @param value - parsed wire or persisted metadata value.
 * @returns whether the value is a supported read permission.
 */
export function isLain42ToolScope(value: unknown): value is Lain42ToolScope {
  return value === 'public-only' || value === 'evidence-only' || value === 'account-read'
}

/**
 * Combine a claimed user RPC with the current turn without allowing a second identity to widen access.
 * @param current - permissions from preceding committed events in this turn.
 * @param message - user message claimed before prompt assembly or committed to the turn.
 * @returns the same policy for unrelated injected context, otherwise the narrowed request policy.
 */
export function claimLain42RequestPolicy(current: Lain42RequestPolicy, message: UserMessage): Lain42RequestPolicy {
  const source = message.source
  if (current.turn === null || source?.kind !== 'user' || !('rpcId' in source)) return current
  const invalid: Lain42RequestPolicy = {
    turn: current.turn, kind: 'invalid', requestId: null, toolScope: null,
  }
  if (typeof source.rpcId !== 'string' || !REQUEST_ID.test(source.rpcId)) return invalid
  const requestId = brandString<SessionRequestId>(source.rpcId)
  const context = 'requestContext' in source ? source.requestContext : undefined
  let next: Lain42RequestPolicy = { turn: current.turn, kind: 'legacy', requestId, toolScope: null }
  if (typeof context === 'object' && context !== null && !Array.isArray(context) && 'lain42' in context) {
    const application = context['lain42']
    if (typeof application !== 'object' || application === null || Array.isArray(application)
      || Object.keys(application).length !== 2 || application['version'] !== 1
      || !isLain42ToolScope(application['toolScope'])) return invalid
    next = { turn: current.turn, kind: 'restricted', requestId, toolScope: application['toolScope'] }
  }
  if (current.kind === 'idle') return next
  if (current.kind === next.kind && current.requestId === next.requestId && current.toolScope === next.toolScope) return current
  return invalid
}

/** Shared definition identity permits effect-owned registration by multiple Agent scopes. */
export const lain42RequestPolicyProjection: ProjectionDefinition<'lain42RequestPolicy'> = {
  key: 'lain42RequestPolicy',
  stateVersion: 1,
  stateSchema: z.object({
    turn: z.number().int().nonnegative().nullable(),
    kind: z.enum(['idle', 'legacy', 'restricted', 'invalid']),
    requestId: z.string().regex(REQUEST_ID).transform(value => brandString<SessionRequestId>(value)).nullable(),
    toolScope: z.enum(['public-only', 'evidence-only', 'account-read']).nullable(),
  }),
  init: () => IDLE,
  apply: (state, event) => {
    if (event.type === 'turn/start') return { ...IDLE, turn: event.data.turn }
    if (event.type === 'turn/end' && event.data.turn === state.turn) return IDLE
    if (event.type === 'user/message') return claimLain42RequestPolicy(state, event.data)
    return state
  },
}

/**
 * Check a relay capability against the exact active request, including direct executor calls.
 * @param policy - host projection or claim-time preview; absence is not permission.
 * @param tool - allowlisted Lain42 relay capability name.
 * @returns whether this request may dispatch the capability.
 */
export function permitsLain42Tool(policy: Lain42RequestPolicy | undefined, tool: string): boolean {
  if (!RELAY_TOOLS.has(tool) || policy === undefined || policy.requestId === null) return false
  if (policy.kind === 'legacy') return true
  if (policy.kind !== 'restricted') return false
  return policy.toolScope === 'account-read' || (policy.toolScope === 'public-only' && tool === 'web_search')
}
