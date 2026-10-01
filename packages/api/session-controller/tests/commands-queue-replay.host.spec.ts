/** Request replay against the production driver and its durable Inbox projection. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

/** External model boundary; removed work must never reach this adapter. */
class QueueReplayAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Unexpected removed work' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('removed request replay with a production Agent Inbox', () => {
  it.each(['queue', 'steer'] as const)(
    'retains an accepted %s identity after command-owner replacement without running removed work',
    async (mode) => {
      const ctx = new Context()
      const release = Promise.withResolvers<void>()
      let maintenance: Promise<void> | undefined
      onTestFinished(async () => {
        release.resolve()
        try { await maintenance }
        finally { await ctx.fiber.dispose() }
      })
      await mountAgentLoopTestDependencies(ctx)
      const loop = await mountAgentLoopTestHarness(ctx)
      const adapter = new QueueReplayAdapter()
      ctx.llm.registerAdapter(['queue-replay'], adapter)
      const selection = { provider: 'queue-replay', model: 'queue-replay-model' }
      const agent = await loop.create(SessionId(`removed-replay-${mode}`), selection, { cwd: '/workspace' })
      const controller = createSessionTestController(ctx, {
        defaultModelSelection: () => selection,
        cwd: '/workspace',
      })
      // Public maintenance holds the real driver before it can claim a prompt.
      // No synthetic inbox events, turn-end notifications, or followup stubs.
      maintenance = agent.runMaintenance(() => release.promise)
      const request: SessionPromptRequest = {
        sessionId: agent.id,
        requestId: brandString<SessionRequestId>(`removed-${mode}`),
        mode,
        content: [{ type: 'text', text: 'Do not resurrect this work' }],
      }
      await expect(controller.prompt(request, new AbortController().signal)).resolves.toEqual({ accepted: true })
      const pending = mode === 'queue' ? agent.inbox.nextTurn : agent.inbox.nextStep
      expect(pending).toHaveLength(1)
      const queued = pending[0]
      if (queued === undefined) throw new Error('Prompt was not queued')
      await expect(controller.updateQueue({
        sessionId: agent.id,
        itemId: queued.id,
        action: { kind: 'remove' },
      })).resolves.toEqual({ accepted: true })
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'agent/inbox/spliced',
        data: {
          target: mode === 'queue' ? 'next-turn' : 'next-step',
          start: 0,
          removedCount: 1,
          inserted: [],
          outcome: 'canceled',
        },
      })

      // A fresh command owner has none of the old admission WeakMap entries.
      // It must recover identity from the actual driver's durable insertion.
      const replacement = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/workspace')
      const beforeReplay = agent.session.snapshotEvents()
      await expect(replacement.prompt(request)).resolves.toEqual({ accepted: true })
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
      expect(agent.session.snapshotEvents()).toEqual(beforeReplay)
      await expect(replacement.prompt({
        ...request,
        content: [{ type: 'text', text: 'Changed accepted work' }],
      })).rejects.toMatchObject({
        code: 'gateway/bad-request',
        details: { issues: [{ reason: 'REQUEST_ID_CONFLICT' }] },
      })
      release.resolve()
      await maintenance
      await agent.whenIdle()
      expect(adapter.requests).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    },
  )
})
