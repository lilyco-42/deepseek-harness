---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-01-prompt-request-digest

English | [中文](2026-10-01-prompt-request-digest.zh.md)

## Summary

Persist a digest for each admitted Session prompt request id.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-01-prompt-request-digest
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "ad9efd0a614721d35a3fbaab3ad272157cc1d03c4c5ef83a1af49b7c5be87355"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "025c5f40bdf0b005c37bc5bcee023783ca237ae05c165d000464a74ebc946858"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "fc2e1c4800841860ea8b1baf5a0af7258a5fab3188145c8e8fda362d4aeb106a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "d427e64d80d57d4f251a2630899411797be291a964ecb0cf3d672e708bac8859"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records without a request digest remain readable. New user-rpc sources add an optional digest, which older readers can ignore. Exact retries return the original acceptance; mismatched or unverifiable historical ids return a conflict rather than replaying another payload.

<a id="verification"></a>
## Verification

GitHub Actions for the session-controller and web bridge are pending. No local build or test was run under the project instruction.

<a id="dev-note"></a>
## Dev Note

None.
