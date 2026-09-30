---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-01-prompt-request-digest

[English](2026-10-01-prompt-request-digest.md) | 中文

## 概述

为每个已准入的 Session prompt request id 持久化摘要。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

没有 request digest 的既有 Session 记录仍可读取。新的 user-rpc source 添加可选摘要，旧 reader 可以忽略。完全相同的重试返回原接受结果；内容不匹配或无法验证的历史 ID 会返回冲突，避免重放其他请求的结果。

<a id="verification"></a>
## 验证

session-controller 与 web bridge 的 GitHub Actions 检查尚待运行。遵循项目指令，未在本机运行构建或测试。

<a id="dev-note"></a>
## 开发备注

无。
