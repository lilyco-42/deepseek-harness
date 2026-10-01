# Bug: cancellation during request admission drops the submitted prompt

**Date reported:** 2026-10-01
**Status:** In progress
**Severity:** High
**Affected scope:** hosted and local DSH conversations

## Symptom and expected behavior

When a turn is cancelled while the `agent/request` admission hook is running, the turn ends as aborted, but its user message is absent from durable history. A following message becomes the only visible prompt, making the conversation appear to skip what the user submitted.

The existing regression scenario is `packages/core/agent-loop/tests/cancel.spec.ts`, “cancels only the matching active turn and ignores a stale turn after the next turn starts”. GitHub Actions run `36791851668` reproduced it: history contained only `second turn`, while the test expected `first turn` and `second turn`; only the second turn reached the model adapter.

## Root cause

`Agent.preStep()` removes the user message from the inbox before `Agent.step()` prepares the provider request. `Agent.step()` normally appends the user message after `prepareRequest()` succeeds. If cancellation aborts that admission hook, the claimed message has left the inbox but was not yet written to the session log.

## Fix in progress

The first admission failure now writes the claimed user messages to the transcript before propagating the failure. This keeps cancelled input visible without sending it to the model or duplicating it on later request retries. Additional regression cases cover the compatibility fallback for runtimes without turn-scoped cancellation and bridge snapshots whose matching user event lacks a preceding turn identity.

## Verification

- Reproduced by GitHub Actions run `36791851668`, Linux exhaustive coverage.
- Linux CI also identified two uncovered compatibility branches; regression coverage was added.
- The fix has not yet been run through Actions. Local builds and tests are intentionally not used for this repository.
- Windows coverage for run `36791851668` is still running; real-model E2E is skipped because its external secret is unavailable.

## Prevention

Once a user message has been claimed for a turn, every exit before model admission must either preserve it in durable history or deliberately restore it to the inbox. Cancellation tests should assert both the terminal turn state and the durable user transcript.
