# Bug: Windows coverage flakes while checking SDK cancellation

**Date Reported**: 2026-09-29
**Date Fixed**: In Progress
**Reporter**: GitHub Actions
**Assignee**: Codex
**Severity**: MEDIUM
**Status**: IN PROGRESS

## Problem

The Windows Node 24 exhaustive coverage job failed in `PiAiAdapter provider routing > stops the SDK request when the adapter idle watchdog expires`. The adapter returned the expected `TIMEOUT`, but the test did not observe the mock server response close within one second. The same full CI run passed Linux coverage and the remaining completed platform gates.

## Root Cause

The mock SSE script continued sending delayed events and could close itself normally, so it did not isolate client cancellation from server completion. The assertion also used a one-second bound for loopback socket closure under heavily instrumented, parallel Windows coverage. The test therefore mixed the behavior under test with scheduler timing and a naturally ending response.

## Fix

Change the fixture to leave the streamed response open after its first event, so only client-side cancellation closes it. Allow five seconds for the Windows runner to observe that close, and force-close mock server connections during cleanup if the assertion fails.

## Files Modified

- `packages/llm/llm-pi-ai/tests/adapter.spec.ts`
- `packages/llm/llm-pi-ai/tests/mock-server.ts`

## Testing

- [x] GitHub Actions reproduces the failure on Windows Node 24 coverage.
- [ ] GitHub Actions re-run after the fix.
- Local build and tests were not run; validation is restricted to GitHub Actions.

## Prevention

Transport-cancellation tests should keep the server response open until the client aborts, then observe the server-side close event. Avoid asserting cancellation with a fixture that can complete normally within the same timeout window.
