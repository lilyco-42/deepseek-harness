# ZeroStack ACP security gate was false green

## Evidence

The upstream ACP permission adapter automatically answered ACP `Ask` prompts with `AllowOnce`. The compatibility smoke scanner emitted `VERIFIED UNSAFE`, but only failed on `NOT VERIFIED`; Actions therefore reported a passing cross-platform run despite unsafe permission semantics. The smoke config also sets `no_tools = true`, so its successful prompt checks prove protocol/model connectivity, not tool permission enforcement.

## Fix

- Make any `VERIFIED UNSAFE` posture fail the ZeroStack compatibility job, preserving `NOT VERIFIED` as a separate review-required failure.
- Keep remote ACP tool execution blocked until permission requests are mediated safely and a runtime test exercises the deny/approval paths.
- Fix the ACP optional callback construction for `exactOptionalPropertyTypes`, and return typed promises from approval test listeners.

## Validation

No local build or test was run. GitHub Actions is the required validation path; an unsafe pinned upstream revision is expected to fail the security gate until its permission behavior is changed and verified.
