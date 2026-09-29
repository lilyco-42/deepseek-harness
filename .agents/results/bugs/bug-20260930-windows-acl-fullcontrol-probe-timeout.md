# Bug: Windows ACL FullControl probe times out in exhaustive coverage

**Date Reported**: 2026-09-30
**Date Fixed**: In Progress
**Reporter**: GitHub Actions
**Assignee**: Codex
**Severity**: Medium
**Status**: Investigating

## Problem

The Windows Node 24 exhaustive coverage run `36640531732` fails the test `sandbox-windows-acl > a FullControl open inside a granted root still works for files`. The child runner reaches its 60-second timeout: `spawnSync` returns `status: null`; the test did not include the child stdout, signal, or timeout error in its failure message. Linux coverage and the other completed Windows tests passed.

## Root Cause

Unknown. The current evidence proves a timeout, but does not identify whether PowerShell startup, the first/second file open, or the intentionally denied directory open is the blocking operation. It is not yet known whether the cause is in the probe, the restricted-token runner, or the ACL behavior.

## Investigation Change

- Add flushed `TRY` / `OPENED` markers around each `CreateFileW` probe so a timed-out run identifies the last completed operation.
- Include `spawnSync` signal, error, stdout, and stderr in the assertion diagnostic.
- Keep the FullControl grant and deny expectation intact; do not weaken or skip this security-boundary test.

## Files Modified

- `packages/sandbox/sandbox-windows-acl/tests/runner.spec.ts`

## Testing

- [x] GitHub Actions run `36640531732` reproduced the Windows-only timeout.
- [ ] GitHub Actions rerun after adding probe diagnostics.
- Local builds and tests are not run; validation is restricted to GitHub Actions.

## Prevention

When a timed subprocess fails with a null exit status, include its signal, timeout error, and captured output so the failure is localized before changing security-sensitive expectations.
