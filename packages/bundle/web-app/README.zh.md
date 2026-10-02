---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供运行 dsh web 表层的用户使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

## 概述

运行 `dsh --profile web`，打开提供聊天、模型与设置管理以及会话历史的交互式浏览器 GUI。它使用与其他 dsh 表层相同的模型访问、工具与安全默认值。启动时会打印带认证信息的 URL，通常还会在默认浏览器中打开；SSH 会话和 `--no-open` 会保留该 URL，供你手动打开。你可以更改端口并允许额外主机，但不能绑定所有网络接口。需要在浏览器中交互式工作时选择本包；一次性的命令行任务应使用 `dsh-headless`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动 GUI、打开浏览器，然后开始与 agent（智能体）对话。flag 用于微调本次调用。

### 启动 Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

启动后你会看到 `dsh web:` 行，其根 URL 携带新的进程 token。除非 `--no-open` 或 SSH 会话抑制，否则默认浏览器会打开该 URL、取得签名 cookie，再重定向到不含认证参数的同一目录。页面加载且你可以与 agent 对话，就说明成功了。两种可预期的失败：前端未构建时，启动会以构建提示停止（checkout 中运行 `pnpm run build`）；浏览器无法打开时，stderr 会打印不含凭据的诊断，但服务器会继续运行——请自行打开已打印的启动 URL。

**设置 → 模型**显示 **DeepSeek**，使用 `DEEPSEEK_API_KEY`。默认模型为 `deepseek-official` / `deepseek-flash`（DeepSeek-V41-Flash）。[DeepSeek 插件](../../llm/llm-deepseek/README.zh.md#endpoint-and-wire-format)使用 Messages API。

已保存的模型选择覆盖组合默认值。设置卡接受兼容 Messages 的 API 地址与凭据引用。

### 配置

大多数用户不需要设置这些；命令行 flag 会提供给下面四个设置——`--host`、`--port` 与 `--trusted-host` 来自本次调用，`--no-open` 仅对本次调用关闭浏览器交接：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent 提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `trustedHosts` | `[]` | 允许从网络访问 GUI 的额外主机 |
| `enableLain42Bridge` | `false` | 注册仅供 Lain42 服务端调用的对话与取消接口 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)是每个受支持字段及其 JSDoc 的穷尽式真源。

### LAN 访问与可信主机

默认情况下 GUI 只接受本机的连接。绑定所有网络接口的部署也会允许 LAN 内的浏览器访问，此时打印的 URL 会附带一个 LAN 地址；`--trusted-host` 在两种情况下都能添加额外主机。Host 与 Origin 检查控制可达性，token 交换则认证每个 Host API 方法与 WebSocket 流。LAN 地址只在启动时采样一次，因此之后的网络变化不会被感知——重启 GUI 以重新公告。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。请在自己的机器上打开转发后的 URL；打印出的 URL 指向远端宿主机 loopback 端点。

### 按会话的 agent 设置

每个浏览器会话选择一个随发行版交付的 preset（默认 `standard`）。Agent 预设设置页可更改默认项并编辑预设的子插件；保存结果持久化到 `$DSH_HOME/profiles/web/cordis.patch.yml`。只有 Host 提供可编辑的 profile 时，Creator 的插件管理工具才会启用。

`lain42-web`、`lain42-web-coding`、`lain42-web-research` 与 `lain42-web-content` 预设供 Lain42 服务端控制面创建会话时使用。它们共享少量按账号隔离的只读网页与 GitHub 工具，但不开放 shell、文件系统、本机桌面、插件管理或子 Agent 工具。公开网页正文只在用户浏览器中读取；如果客户端已经在用户轮次中加入 `[Lain42 browser-fetched evidence]`，Agent 应使用该结果，不要重复读取同一网页。如果浏览器受 CORS 或网络策略限制而无法读取，用户需要粘贴正文或附加文件，服务器不会代为抓取。预设只限制 Agent 能力，不负责验证网站用户身份或授权会话访问；控制面必须通过自己的已认证归属映射解析每个不透明的公开会话。

### Lain42 私有控制面接口

`enableLain42Bridge` 会添加一个 `POST /lain42/bridge/v1/turn` 路由，仅供已认证的 New API 后端调用。它要求设置 `LAIN42_DSH_BRIDGE_SECRET`（至少 32 字节），并与 New API 服务端使用的密钥一致。请求带有时间戳 HMAC、一次性 nonce、不透明会话 ID、UUID 请求 ID、有界文本，以及由 New API 选择的必填模型 ID；`general`、`coding`、`research`、`content` 模式可以省略，省略时使用 `general`。缺少模型 ID 的请求会被拒绝，不会回退到 DSH 进程级默认模型。v2 请求还可以携带最多 4 张 PNG、JPEG、WebP 或 GIF 图片，解码后合计不超过 8 MiB；图片会先通过 DSH 现有的附件校验，再进入模型请求。路由把模式映射到服务端固定的预设，并保持 `lain42-web` 模型 provider 不变；不接受 provider、目录或命令覆盖。当前只返回完成后的助手文本，不支持流式传输或任意二进制附件。

同一选项还会注册 `POST /lain42/bridge/v1/cancel`。其独立签名的 JSON 请求体最多为 4096 字节，只包含版本 `1`、原始会话 ID 和请求 ID；对话路由的签名不能授权取消操作。该路由调用 `sessionController.cancelPrompt`，并在回执中保留原始身份。`removed` 表示已移除排队输入；`cancellation-requested` 标识一个仍须观察终态事件的活动轮次。回执不证明任务已进入终态。对话等待器重放已提交的 Inbox 变更：自身排队请求被取消后立即结束观察，不等待不存在的轮次；请求被确切领取后，会在首条用户消息出现前确定所属轮次。`not-found` 不会为未来输入预留身份或取消未来输入；控制面负责保存取消意图并协调接收过程。仅有网络断开不会取消工作。

该 preset 还会挂载 `@deepseek-ai/dsh-web-app/lain42-tools`。中继默认使用 `https://api.lain42.top/api/agent/bridge/v1/tool`；只有切换到其他环境时才需要用 `LAIN42_AGENT_TOOL_RELAY_URL` 覆盖。DSH 服务使用已有的 `LAIN42_DSH_BRIDGE_SECRET` 为有界请求签名。New API 验证 HMAC 和一次性 nonce 后，根据已保存的 DSH 会话归属解析 Lain42 账号，并仅执行指定的只读搜索、网页读取、仓库、Issue 或 PR 操作。GitHub OAuth 令牌留在 New API，按解析出的账号选择，不会发送到 DSH 或浏览器。公开网页和仓库内容都作为不可信模型输入。如果中继 URL 或共享密钥无效，工具会返回可操作的服务不可用提示，不会让普通聊天整体停用。

要让模型按账号计费，本 bundle 还会为 `lain42-web` 模型路由提供可选的 `llmRequestHeaders` 解析器。DSH 与 New API 必须设置相同且独立的 `LAIN42_AGENT_MODEL_RELAY_SECRET`（至少 32 字节），再把 provider profile 指向 `https://api.lain42.top/v1/agent`，模型 id 使用 New API 已启用的名称。解析器会为每次请求签署服务端创建的 DSH 会话 id 和模型名称，不会把签名密钥发送到浏览器。New API 会拒绝缺少有效服务端 Agent 会话映射的请求，因此控制面必须在服务端创建映射并传递私有 DSH 会话 id。

请把该 DSH 进程运行在专用服务器实例中并绑定 loopback 或私有网络，只允许 New API 后端访问此路由。该接口认证的是可信的 New API 服务，不替代 New API 的用户与会话归属校验，也不会让 DSH Web 界面及其其他 API 适合公开。不要在个人配对设备（例如所有者的 A7A）上启用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

此 bundle 由补丁层、运行时胶水插件和仅供 Lain42 预设使用的账号工具插件组成：`cordis.patch.yml` 承载宿主行和 preset 注册表，每个 `presets/<id>.patch.yml` 插入一条随发行版交付的 preset 声明，按 `dsh.bundle.patch` 列出的顺序应用。存储栈与投影缓存来自 `dsh-base`；Web 叠加层的工作区和消息反馈条目消费共享的 `storageDomain` 服务。补丁重述 base 有意省略的界面专用值，插入 Web 专用宿主条目和浏览器插件列表，再将 Agent 层移到预设后面。胶水插件负责 dist 服务、信任采样、提示词段落、bash 变量和就绪通知。Lain42 工具插件只会由专用 preset 加载。`office-to-pdf` 条目为宿主消费者挂载一个延迟创建引擎的 [Office 转换提供方](../../document/office-to-pdf/README.zh.md)，使用此 bundle 的 Desktop 组合也共享该提供方。转换服务的 Remote 方法负责预览读取授权，Document Preview 负责 Office 查看器和客户端缓存。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona 前缀与后缀模板、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算、通过 required 启动检查且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。此时 client combo JavaScript 和 source map 仍未物化。可选插件失败不会阻止就绪宣告；required 启动失败或启动中途被释放的树不会宣告任何内容。

### LAN 信任采样

`resolveLanTrust` 在启动时只采样一次网络：loopback 绑定（`127.0.0.1`）不派生任何 LAN 地址，绑定所有网卡则会加入每个非 internal IPv4 字面量。派生字面量加上显式的 `--trusted-host` 权威标识组成 `/api` 浏览器信任栅栏，打印的 LAN URL 始终与该栅栏一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、LAN 信任采样、提示词段落、bash 变量、URL 行、浏览器交接 |
| [`src/lain42-bridge.ts`](src/lain42-bridge.ts) | Lain42 控制面使用的 HMAC 认证私有对话与原请求取消路由 |
| [`src/lain42-tools.ts`](src/lain42-tools.ts) | 仅在专用 preset 中注册、经 New API 按账号隔离转发的只读工具 |
| [`src/lain42-model-relay.ts`](src/lain42-model-relay.ts) | 发往 New API 的会话与模型级签名请求头 |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--trusted-host`、`--no-open`、`--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 注册表 |
| [`presets/`](presets) | 每个随发行版交付的 preset（`standard`、`ptc`、`minimal`、`cordis` 和四种 `lain42-web*` 模式）各一条 `@deepseek-ai/dsh-agent-preset` 声明，各自一个补丁文件 |
| — | 不发布运行时不变式伴生入口；每项贡献（frontend-static 子插件、提示词段落、bashEnv 注册）都会随 fiber 由注册表释放，且每个所属注册表的包负责该关系的不变式；本包不持有需要审计的可变状态。 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist 解析、回退席位、提示词段落、就绪宣告 |
| [`tests/lain42-bridge.spec.ts`](tests/lain42-bridge.spec.ts) | 签名桥接请求、有界输入、持久化轮次结果与失败处理 |
| [`tests/lain42-tools.spec.ts`](tests/lain42-tools.spec.ts) | preset 工具注册、会话绑定请求、签名与安全失败处理 |
| [`tests/lain42-model-relay.spec.ts`](tests/lain42-model-relay.spec.ts) | 模型中继签名与无效请求处理 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN 信任采样 |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | 页面可达后的默认浏览器交接 |

### 不变式归属

不发布不变式伴生入口，因为每项贡献——frontend-static 子插件、提示词段落与 bash 变量注册——都会随 fiber 由注册表释放，且每个所属注册表的包负责该关系的不变式。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你想深入了解共享核心、浏览器重载流水线或已构建的前端时，阅读以下页面。

- [组合包索引](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——GUI 运行其上的共享核心。
- [dsh-client-hmr](../../client/hmr/README.zh.md)——开发期间客户端插件变更如何重载。
- [frontend-static](../../host/frontend-static/README.zh.md)——已构建的前端如何被服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到什么

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（first-party 顺序 10100，位于可复用指令之后）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

源码与 Web 段落位于第一方可复用指令之后。工具与配置一致时，不同 checkout 路径或本地端口不会改变前置前缀；不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Lain42 历史窗口**——私有对话等待器从最近 50 条消息开始观察。请求或其先前的 Inbox 插入位于窗口之外时无法重建；更早结果的查询与托管终态回传仍未完成。仅有取消回执不代表结果已恢复。


这些限制告诉你在不常见的环境下会遇到什么——源码 checkout、SSH 会话或严格网络。它们是当前包约束，不是通用的浏览器对比或任务积压。

- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **LAN 地址只在启动时采样一次**——启动后的网卡变化不会重新公告；打印的 LAN URL 始终与采样结果一致。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——打印的 URL 指向远端宿主机 loopback 端点；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，`--host 0.0.0.0` 会在启动时被拒绝；请使用默认 loopback 主机。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

Web 组合包含账号 Remote 控制器和账号设置页面。
