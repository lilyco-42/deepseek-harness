# Agent Note: ZeroStack ACP worker 接入条件

Status: proposed

[English](2026-09-25-zerostack-acp-worker-admission.md) | 中文

## 问题

Lain42 需要让设备本地执行 coding 工作，而不能让共享网站服务在公共服务器上执行用户工具。ZeroStack 提供了可选 Cargo 功能的外部 ACP agent，但仅凭资源占用较低，不能证明它适合连接到浏览器可控制的 worker。

## 提议

DeepSeek Harness（DSH）继续作为 Web 与移动端产品运行时，负责界面、身份、会话、模型路由和工具策略。ZeroStack 只作为可选外部 ACP worker；在审查分发义务前，不把它的 Rust 代码链接进 DSH，也不捆绑其 GPL-3.0-only 二进制。DSH 现有的 [`subagent-acp` 提供方](../../../../packages/subagent/subagent-acp/README.zh.md)是本机进程边界：只有 DSH 运行时与 ZeroStack 在同一台机器上时，它才能启动 ZeroStack；它不会把 ACP 请求转发到用户配对的设备。因此，云端 Web Agent 不应把该提供方配置成在共享应用服务器启动 ZeroStack，再称其为“用户本机”。浏览器到用户设备的产品链路需要单独、按账号认证的节点传输，在该用户已配对的节点上启动固定且由管理员安装的 worker。浏览器不能指定任意可执行文件、参数、工作目录或环境变量。在这条传输和隔离实现前，ZeroStack 只适合作为用户自行运行的本地实验。

候选配置为 `--no-default-features --features acp`。GitHub Actions 使用上游提交 [`16fadb3b8f29238a5716eaf937ecf9d41a42f946`](https://github.com/gi-dellav/zerostack/commit/16fadb3b8f29238a5716eaf937ecf9d41a42f946) 完成构建并启动；在 2026-09-25 查询时，该提交是上游 `main` 的头部。每次运行都会初始化 ACP、创建会话，然后在不调用模型的情况下采样进程 RSS 24 次、持续 4.8 秒：

| 运行平台 | 默认配置平均／峰值 | 精简配置平均／峰值 | 仅 ACP 平均／峰值 |
|---|---:|---:|---:|
| Linux ARM64 | 25,093 / 25,176 KiB | 22,425 / 22,504 KiB | 21,326 / 21,400 KiB |
| Linux x64 | 25,955 / 26,068 KiB | 25,742 / 25,828 KiB | 23,548 / 23,636 KiB |
| Windows x64 | 14,432 / 14,432 KiB | 14,332 / 14,332 KiB | 14,032 / 14,032 KiB |

这些数据表明仅 ACP 配置是一个可行的精简版本，ARM64 上的降幅最明显。测量对象是创建会话后的 worker，不包括完整 DSH 应用、活跃推理、CPU 负载或生产任务；也不能证明相对 DSH 的端到端内存节省。[GitHub Actions run 36103765718](https://github.com/lilyco-42/deepseek-harness/actions/runs/36103765718) 的 9 个构建和冒烟任务全部通过，源码审计仍检测到 ACP 自动批准 Ask，并阻止远程写入。

ZeroStack 的自定义 OpenAI provider 支持配置 base URL，并从环境变量读取 API key；自定义 base URL 默认使用 Chat Completions（[provider 配置](https://github.com/gi-dellav/zerostack/blob/main/docs/CONFIG.md#openai-api-styles-and-custom-headers)）。因此 OpenAI 兼容的 Lain42 `/v1` 有望作为每个用户自己的模型路由，但本轮 CI 没有实际请求模型。在对外宣称已接通前，应先用合成测试 key 在 GitHub Actions 增加 mock gateway 冒烟，覆盖 `/models`、流式 `/chat/completions` 和认证；之后再在 CI 以外，用某位用户自行签发的受限 key 验证真实网关。该 key 只应保存在用户自己的节点，不应放进共享服务器配置或浏览器包。

目前不要把 ZeroStack 暴露为可由网页控制的远程写入 worker。其 ACP 实现会自动用 `AllowOnce` 响应 `Ask` 权限请求；ACP 路径不检查 `--read-only` 标志；安全指南说明沙箱只约束 Bash，agent 自带文件工具与 MCP 服务器仍在沙箱之外（[权限实现](https://github.com/gi-dellav/zerostack/blob/16fadb3b8f29238a5716eaf937ecf9d41a42f946/src/extras/acp/mod.rs)、[安全指南](https://github.com/gi-dellav/zerostack/blob/16fadb3b8f29238a5716eaf937ecf9d41a42f946/SECURITY.md)）。版本说明：v1.7.2 发布说明提到 PR #212 修复“headless 模式 Ask fail closed”，但该修改针对非交互 `-p` CLI 调度；v1.7.2 标签下的 ACP 权限函数仍会创建 Ask 通道并以 `AllowOnce` 应答（[PR #212](https://github.com/gi-dellav/zerostack/pull/212)、[v1.7.2 ACP 源码](https://github.com/gi-dellav/zerostack/blob/v1.7.2/src/extras/acp/mod.rs)）。不能把这条发布说明当成 ACP 安全修复。未来的 Web 到设备链路必须做到每个账号独立运行 worker，并通过已测试的操作系统级沙箱，仅开放该账号选定的工作区和明确允许的网络目标。个人设备和所有者的私有 Radxa 不得进入共享 worker 池。

## 考虑过的替代方案

**只使用 DSH 作为 worker。** 不作为唯一长期选项，因为这会放弃更精简的独立 ACP worker；DSH 仍是默认产品和策略宿主。

**用 ZeroStack 替换 DSH。** 不采用，因为 ZeroStack 不提供 Lain42 的 Web／移动产品、账号隔离、会话或模型网关，而且当前 ACP 权限行为不适合远程写入。

**立即内嵌或捆绑 ZeroStack。** 不采用，因为 x64 与 Windows 的内存收益有限，许可证为 `GPL-3.0-only`，而进程内集成会增加不必要耦合并绕过现有进程隔离接口。

**只靠只读配置开放远程写操作。** 不采用，因为 ACP 不执行 CLI 的只读标志，上游沙箱也没有约束所有文件与 MCP 操作。

## 验收标准

- ACP 权限请求必须转交给 DSH 中由人控制的审批流程，或以拒绝方式失败；worker 不得静默授权。
- 通过每账号独立的操作系统沙箱证明，选定工作区外的读取和写入会被拒绝，并覆盖直接文件工具、子进程、MCP、符号链接或同等文件系统逃逸方式。
- 每个用户的 worker 凭据与环境相互隔离；一次 Web 请求无法启动或访问其他用户的进程与工作区。
- Lain42 面向用户下载或捆绑 ZeroStack 前，先审查 GPL-3.0-only 使用、声明和二进制分发义务。
- GitHub Actions 从经审查的上游固定提交构建并运行 Linux x64、Linux ARM64、Windows x64 的 ACP 会话创建；同一轮 CI 还需在相同 runner 上对代表性 coding 任务和空闲 RSS 与 DSH 做对比。
- 浏览器或手机请求只能通过独立节点传输到该账号自己的配对设备；云端应用进程不能启动用户指定命令，也不能收到其他用户的工作区路径。

## 风险

RSS 样本是短时空闲测量，会受到 runner 和操作系统差异影响。除非 DSH 与 ZeroStack 在同一 runner 上执行同一代表性任务，否则无法据此确认端到端内存或 CPU 节省。现有本机子进程提供方并不能解决云端到用户设备的传输问题。实现完整的跨平台沙箱和符合 GPL 的分发方式，所需工程投入可能高于当前测出的收益。
