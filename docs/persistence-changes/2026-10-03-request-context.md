---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-request-context

English | [中文](2026-10-03-request-context.zh.md)

## Summary

Adds optional opaque application request metadata to the persisted user RPC source.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-request-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-01-prompt-request-digest"
    after: "f94a9931b0023fef00408e5dd148a1a6ca6b3be14a3bf030257d8db257863969"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-01-prompt-request-digest"
    after: "2f4cfcceaf26ceb6d44a600e51357f45aa564e284730cf18a1819d8c8eca5c20"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-01-prompt-request-digest"
    after: "d80ff182d0828e24b6ba5f2bc59f1e5c4b393fd530535886b84e1045a108164e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-01-prompt-request-digest"
    after: "521b4cece7c02534716d0276d4111f299b83d662ebdd7cbf16edad5432a8c69a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing user sources remain readable and requests without metadata retain their original identity digest. Metadata is bounded lossless JSON, copied before admission and included in retry identity. It is not prompt text and does not grant capabilities by itself. Older readers may ignore the optional field; an application using it for permissions must require a matching policy consumer rather than treating an older reader as an authorization check.

<a id="verification"></a>
## Verification

The Actions request-lifecycle lane exercises unchanged replay, changed or omitted metadata rejection, command-owner replacement, mutation during asynchronous admission, exact UTF-8 size limits and malformed JSON rejection. Current results must be checked on the candidate commit; this record does not assert that pending CI has passed.

<a id="dev-note"></a>
## Dev Note

None.
