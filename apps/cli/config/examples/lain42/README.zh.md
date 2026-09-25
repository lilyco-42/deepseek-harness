# Lain42 Agent：修订后的交付目标

[English](README.md) | 中文

以 DeepSeek Harness 作为 Agent（智能体）运行时，并将 Lain42 设为默认模型网关。用户可以通过手机或浏览器聊天，并调用**该用户自己**配对的 headless 节点上的工具。所有者的 Radxa A7A 是私有设备，绝不能作为其他用户的共享执行主机。

这是一个可选的第一阶段，不用于公开部署。上游 `dsh web` 是本地、通过进程令牌认证的单用户应用。公开多用户访问需要独立的 Lain42 控制面：它要认证每位用户、将每个会话映射到恰好一个归属设备、只转发已授权的 Agent 事件，并且绝不暴露设备的本地 Web 端口或凭据。

## 当前第一阶段

`cordis.patch.yml` 通过官方 `llm-pi-ai` 适配器，将默认模型路由到现有的 OpenAI 兼容 Lain42 API。模型 id 和 API key 来自节点所有者的环境变量，不会提交到仓库。该配置会禁用官方 DeepSeek 模型与搜索适配器，以及内置的 session-log 和 telemetry 导出。公开 URL 抓取仍可用。搜索需要另行配置提供方，因此此阶段**尚未就绪**。Actions smoke 使用模拟网关和代理提供的测试页面，验证抓取正文会进入下一次模型请求；它不验证真实 Lain42 网关是否可用或回答质量。

在安装了 `dsh` 且所选模型 id 存在于该用户 Lain42 账户的私有节点上：

```sh
export LAIN42_MODEL='<available-model-id>'
export LAIN42_API_KEY='<your-own-lain42-token>'
dsh web --no-open --patch /path/to/cordis.patch.yml
```

该路由固定使用 `https://api.lain42.top/v1`。如需对其他地址进行受控测试，请在私有 overlay 中修改 `baseURL`，不要在发布配置里嵌入环境表达式。不要把 token 写进 overlay、URL、浏览器页面或共享服务器环境。不要将本地 Web 端口暴露到互联网。

## 替换现有网站 Agent 前的验收标准

1. 通过 Lain42 发起真实模型调用，准确回答“DeepSeek 是什么？”，并在后续对话中保持同一主题。30 条对话回归集还要检查短消息、失败轮次和带引用的网页搜索结果。
2. 模型能够抓取用户提供的公开 URL，并引用实际抓取到的内容。搜索必须返回可验证来源，或明确说明当前不可用；绝不能编造结果。
3. 浏览器 GitHub OAuth 可以读取用户的仓库，无需 `gh auth login`。本地 `gh` 调用只在该用户配对的节点上运行，并向用户显示实际执行路径。
4. 两个账号无法读取或调用对方的会话、文件、凭据、设备和工具。设备所有者的 Radxa 仍无法被其他账号访问。
5. GitHub Actions 构建并运行相关测试。在公开发布前，还要针对 staging 部署验证手机浏览器、离线和重连场景。

在以上五项全部通过之前，不替换现有 `/agent` 页面，也不宣称工作已完成。
