/** Observe one committed prompt insertion without replacing the shipped runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'

/** Wait for Session lifecycle availability before observing its durable events. */
export const inject = ['sessions']

/**
 * Report one original prompt's committed queue admission over test-owned IPC.
 * @param ctx Real Loader context that emits committed Session events.
 * @param config Exact Session and request identities owned by the test.
 */
export function apply(ctx: Context, config: { sessionId: string; requestId: string }): void {
  if (process.send === undefined) throw new Error('Prompt observer requires an IPC channel')
  let reported = false
  ctx.on('session/event', (session, event) => {
    if (reported || session.id !== config.sessionId || event.type !== 'agent/inbox/spliced') return
    const matching = event.data.inserted.some(message => message.source.kind === 'user'
      && 'rpcId' in message.source && message.source.rpcId === config.requestId)
    if (!matching) return
    reported = true
    process.send!({ command: 'prompt-queued', sessionId: session.id, requestId: config.requestId })
  }, { global: true })
}
