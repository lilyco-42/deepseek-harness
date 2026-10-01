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

The loop now tracks the original inbox batch separately from messages added by `agent/pre-step`. Cancellation before request admission commits that original batch only when the caller explicitly sets `keepInbox`; it never commits generated pre-step context or the system prompt. Default cancellation still commits no model input. Once request admission succeeds, the ordinary first-attempt append path owns the messages, avoiding duplicates across retries. Regression coverage exercises both turn-scoped `keepInbox` cancellation and the existing default-cancellation admission cases.

## Verification

- Reproduced by GitHub Actions run `36791851668`, Linux exhaustive coverage.
- Linux CI also identified two uncovered compatibility branches; regression coverage was added.
- The corrected behavior has not yet been run through a fresh Actions workflow. Local builds and tests are intentionally not used for this repository.
- The earlier workflow exposed a regression in default cancellation: it committed the entire prepared message list. The corrected change narrows preservation to explicitly requested `keepInbox` cancellation and the original claimed inbox batch.

## Prevention

Cancellation before request admission must preserve claimed inbox input only when `keepInbox` requests it; default cancellation must leave no user or system messages committed. Tests assert both the terminal turn state and the durable transcript, including pre-step context boundaries.
