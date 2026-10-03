---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-request-context

[English](2026-10-03-request-context.md) | 中文

## 概述

在持久化的用户 RPC 消息来源中增加可选的不透明应用请求元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有用户来源仍可读取，未提供元数据的请求保留原身份摘要。元数据为有界无损 JSON，在准入前复制并计入重试身份；它不是提示文本，也不自行授予能力。旧读取方可忽略此可选字段；将它用于权限的应用必须要求匹配的策略消费方，不能把旧读取方当作授权检查。

<a id="verification"></a>
## 验证

Actions 的 request-lifecycle 任务检查原样重试、改变或省略元数据时拒绝、命令所有者替换、异步准入时修改输入、UTF-8 大小边界和不合法 JSON 拒绝。须核对候选提交的当前结果；本记录不宣称等待中的 CI 已通过。

<a id="dev-note"></a>
## 开发备注

无。
