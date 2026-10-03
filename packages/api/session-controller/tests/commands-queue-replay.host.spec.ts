/** Request replay against the production driver and its durable Inbox projection. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
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

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Unexpected removed work' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Unexpected removed work' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** External inference that stays open until its production cancellation signal arrives. */
class CancellableReplayAdapter extends QueueReplayAdapter {
  readonly started = Promise.withResolvers<AbortSignal>()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('The production loop must supply a cancellation signal')
    this.requests.push(options)
    this.started.resolve(signal)
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request canceled' } } }
  }
}

describe('removed request replay with a production Agent Inbox', () => {
  it.each(['queue', 'steer'] as const)(
    'retains an accepted %s identity after command-owner replacement without running removed work',
    async (mode) => {
      const ctx = new Context()
      const release = Promise.withResolvers<undefined>()
      const maintenance: { result?: Promise<void> } = {}
      onTestFinished(async () => {
        release.resolve(undefined)
        try { await maintenance.result }
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
      maintenance.result = agent.runMaintenance(() => release.promise)
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
      await expect(controller.cancelPrompt({ sessionId: agent.id, requestId: request.requestId }))
        .resolves.toEqual({ accepted: true, status: 'not-active' })
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
      release.resolve(undefined)
      await maintenance.result
      await agent.whenIdle()
      expect(adapter.requests).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    },
  )
})

it('cancels an actually claimed prompt before model admission and cannot stop a newer turn', async () => {
  const ctx = new Context()
  const firstStarted = Promise.withResolvers<undefined>()
  const firstRelease = Promise.withResolvers<undefined>()
  const secondStarted = Promise.withResolvers<AbortSignal>()
  const secondRelease = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    firstRelease.resolve(undefined)
    secondRelease.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new QueueReplayAdapter()
  ctx.llm.registerAdapter(['queue-replay'], adapter)
  const selection = { provider: 'queue-replay', model: 'queue-replay-model' }
  const agent = await loop.create(SessionId('cancel-claimed-prompt'), selection, { cwd: '/workspace' })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => selection,
    cwd: '/workspace',
  })
  ctx.on('agent/pre-step', async ({ turn, signal }, next) => {
    if (turn === 1) {
      firstStarted.resolve(undefined)
      await firstRelease.promise
    } else if (turn === 2) {
      secondStarted.resolve(signal)
      await secondRelease.promise
    }
    return next()
  })
  const request: SessionPromptRequest = {
    sessionId: agent.id,
    requestId: brandString<SessionRequestId>('claimed-cancel-original'),
    mode: 'queue',
    content: [{ type: 'text', text: 'Stop only this request' }],
  }
  await controller.prompt(request, new AbortController().signal)
  await firstStarted.promise
  expect(agent.inbox.nextTurn).toEqual([])
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
  await expect(controller.cancelPrompt({ sessionId: agent.id, requestId: request.requestId }))
    .resolves.toEqual({ accepted: true, status: 'cancellation-requested', turn: 1 })
  firstRelease.resolve(undefined)
  await agent.whenIdle()
  expect(adapter.requests).toEqual([])
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
    .toMatchObject({ data: { turn: 1, reason: { kind: 'aborted' } } })
  // Exact replay of the cancelled prompt must not become another queued task.
  await expect(controller.prompt(request, new AbortController().signal)).resolves.toEqual({ accepted: true })
  expect(agent.inbox.nextTurn).toEqual([])
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'New work' }], source: { kind: 'user' } }))
  const nextSignal = await secondStarted.promise
  await expect(controller.cancelPrompt({ sessionId: agent.id, requestId: request.requestId }))
    .resolves.toEqual({ accepted: true, status: 'not-active' })
  expect(nextSignal.aborted).toBe(false)
  secondRelease.resolve(undefined)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
    .toMatchObject({ data: { turn: 2, reason: { kind: 'completed' } } })
})

it('propagates request-scoped cancellation to an executing model and records its terminal outcome', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new CancellableReplayAdapter()
  ctx.llm.registerAdapter(['queue-replay'], adapter)
  const selection = { provider: 'queue-replay', model: 'queue-replay-model' }
  const agent = await loop.create(SessionId('cancel-running-prompt'), selection, { cwd: '/workspace' })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => selection,
    cwd: '/workspace',
  })
  const request: SessionPromptRequest = {
    sessionId: agent.id,
    requestId: brandString<SessionRequestId>('running-cancel-original'),
    mode: 'queue',
    content: [{ type: 'text', text: 'Cancel this executing request' }],
  }
  await controller.prompt(request, new AbortController().signal)
  const inferenceSignal = await adapter.started.promise
  expect(inferenceSignal.aborted).toBe(false)
  await expect(controller.cancelPrompt({ sessionId: agent.id, requestId: request.requestId }))
    .resolves.toEqual({ accepted: true, status: 'cancellation-requested', turn: 1 })
  expect(inferenceSignal.aborted).toBe(true)
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
    .toMatchObject({ data: { turn: 1, reason: { kind: 'aborted' } } })
  await expect(controller.prompt(request, new AbortController().signal)).resolves.toEqual({ accepted: true })
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  await expect(controller.cancelPrompt({ sessionId: agent.id, requestId: request.requestId }))
    .resolves.toEqual({ accepted: true, status: 'not-active' })
})
