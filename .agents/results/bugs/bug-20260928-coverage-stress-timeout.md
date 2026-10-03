# Bug: Coverage stress test exceeded its wall-clock budget

**Date Reported**: 2026-09-28
**Date Fixed**: In Progress
**Reporter**: GitHub Actions
**Assignee**: Codex
**Severity**: MEDIUM
**Status**: IN PROGRESS

## Problem

The exhaustive Node coverage job failed in the 6,000,000-element completion-value regression test. The runtime returned `wall-clock ceiling reached (60000ms)` before the test could verify the result. The expected behavior is to verify the O(depth) traversal's memory shape without treating shared-runner scheduling and coverage instrumentation as a performance requirement.

## Root Cause

The stress tests allowed 60 seconds for a Python-level traversal of six million elements under V8 coverage. The test comments already explain that instrumentation and concurrent coverage workers make this substantially slower than an idle run, but the configured runtime ceiling remained too low for the observed CI load.

## Fix

Raised the runtime ceiling to 120 seconds and the enclosing Vitest timeout to 180 seconds for both adjacent six-million-element traversal tests. The data size, address-space limit, expected values, and memory-shape assertions remain unchanged; this adjusts only the time budget.

## Files Modified

- `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts`

## Testing

- [x] Existing CI failure establishes the triggering condition.
- [ ] GitHub Actions re-run after the fix.
- [ ] Windows full-coverage job from the previous commit completes.
- Local build and tests were not run; validation is restricted to GitHub Actions.

## Prevention

Keep resource-shape assertions independent from wall-clock performance claims. Stress-test budgets should account for coverage instrumentation and shared CI runner load, while retaining a finite ceiling to catch hangs.
