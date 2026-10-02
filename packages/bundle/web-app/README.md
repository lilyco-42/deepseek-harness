---
description: "The browser GUI for dsh: interactive chat, model and settings management, and session history, for users running the dsh web surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

English | [中文](README.zh.md)

## Summary

Run `dsh --profile web` to open an interactive browser GUI with chat, model and settings management, and session history. It uses the same model access, tools, and safety defaults as other dsh surfaces. Startup prints an authenticated URL and normally opens it in the default browser; SSH sessions and `--no-open` leave the URL for manual opening. You can change the port and allow extra hosts, but cannot bind all network interfaces. Choose this package for interactive browser work; use `dsh-headless` for one-shot command-line tasks.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Start the GUI, open your browser, and start talking to the agent. The flags fine-tune the invocation.

### Starting the Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

After startup you see a `dsh web:` line whose root URL carries a fresh process token. Unless `--no-open` or an SSH session suppresses it, the default browser opens that URL, receives a signed cookie, and redirects to the same directory without the token. You know it worked when the page loads and you can chat with the agent. Two failures to expect: if the frontend is not built, startup stops with a build hint (`pnpm run build` in a checkout); if the browser cannot be opened, a credential-free diagnostic prints to stderr while the server keeps running — open the printed startup URL yourself.

**Settings → Models** displays **DeepSeek**, using `DEEPSEEK_API_KEY`. The default is `deepseek-official` / `deepseek-flash` (DeepSeek-V41-Flash). The [DeepSeek plugin](../../llm/llm-deepseek/README.md#endpoint-and-wire-format) uses the Messages API.

Saved model selections override the composition default. The settings card accepts a Messages-compatible API address and a credential reference.

### Configuration

Most users never set these; the command-line flags feed the four settings below — `--host`, `--port`, and `--trusted-host` come from the invocation, and `--no-open` turns the browser handoff off for that invocation:

| Field | Default | Meaning |
|---|---|---|
| `openBrowser` | `true` | Open the default browser after startup; SSH launches suppress it |
| `printUrl` | `true` | Print the `dsh web:` URL line at startup |
| `surfaceContext` | `true` | Give the agent GUI-orientation context and expose `DSH_WEB_URL` to its shell commands |
| `trustedHosts` | `[]` | Extra hosts allowed to reach the GUI from the network |
| `enableLain42Bridge` | `false` | Register the private Lain42 server-to-server turn and cancellation routes |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) is the exhaustive source for every accepted field and its JSDoc.

The private Lain42 turn route acknowledges a completed answer only after the Session store's durability checkpoint succeeds. Missing persistence or a failed checkpoint returns an error rather than an answer that may disappear on immediate process loss. The checkpoint does not invoke the model again.

### LAN access and trusted hosts

By default the GUI accepts connections from this machine only. A deployment that binds all network interfaces also allows browsers from the LAN, and the printed URL then includes a LAN address; `--trusted-host` adds extra hosts in either case. Host and Origin checks control reachability, while the token exchange authenticates every Host API method and WebSocket stream. The LAN addresses are sampled once at startup, so a network change later is not picked up — restart the GUI to re-advertise.

### Running over SSH

When you launch `dsh --profile web` over SSH, the URL line still prints but the browser is not opened for you: the SSH client or editor owns the local forwarding address. Open the forwarded URL on your machine yourself; the printed URL names the remote host's loopback endpoint.

### Per-session agent setup

Each browser session selects a shipped preset (`standard` by default). The Agent presets settings page changes the default and edits preset child plugins; saves persist in `$DSH_HOME/profiles/web/cordis.patch.yml`. Creator's plugin-management tool is enabled only when the Host provides an editable profile.

The `lain42-web`, `lain42-web-coding`, `lain42-web-research`, and `lain42-web-content` presets are for Sessions created by the Lain42 server control plane. They share a small set of account-scoped, read-only web and GitHub tools, but expose no shell, filesystem, native-desktop, plugin-management, or subagent tools. Public page contents are read only in the browser. If a client includes `[Lain42 browser-fetched evidence]` in the user turn, the Agent should use it instead of repeating the same page read. If browser CORS or network policy blocks the read, ask the user to paste the text or attach a file; the server does not fetch the page. A preset limits Agent capabilities; it does not authenticate website users or authorize access to Sessions. The control plane must resolve each opaque public Session through its own authenticated ownership mapping.

### Private Lain42 control-plane bridge

The account tool `lain42_github_issue` reads an exact repository/issue number through New API, including closed issues. It returns the issue body (at most 12 KiB) and up to three oldest comments (2 KiB each), with truncation and partial-comment errors. Both browser-prepared Issue evidence and this model-selected read share the same New API reader. The OAuth token stays in New API; DSH receives only returned content. This read does not inspect repository source files or write issue replies or code changes.

`enableLain42Bridge` adds one `POST /lain42/bridge/v1/turn` route for the authenticated New API backend. It requires `LAIN42_DSH_BRIDGE_SECRET` (at least 32 bytes) and a matching New API server secret. Requests use a timestamped HMAC, a one-use nonce, an opaque Session id, a UUID request id, bounded text, a required model id selected by New API, and an optional mode from `general`, `coding`, `research`, or `content`. Requests without a model id are rejected; they never fall back to the DSH process-wide default. Version 2 requests can also carry up to four PNG, JPEG, WebP, or GIF images with an aggregate decoded size of at most 8 MiB. DSH admits image bytes through its normal attachment validator before the model sees them. The route maps mode to a server-owned preset and keeps the model provider fixed at `lain42-web`; it accepts no provider, directory, or command override. It returns completed assistant text and does not stream or accept arbitrary binary attachments.

The same option registers `POST /lain42/bridge/v1/cancel`. Its separately signed, at-most-4096-byte JSON body contains only version `1` and the original Session and request ids; a turn-route signature cannot authorize cancellation. The route delegates to `sessionController.cancelPrompt` and returns its receipt with the original identity. `removed` means queued input was removed; `cancellation-requested` identifies an active turn whose terminal event still needs observation. A receipt never proves terminal settlement. The turn waiter reconstructs committed Inbox mutations: cancellation of its queued request ends observation without waiting for a nonexistent turn, and an exact claim identifies its turn before the first user-message event. `not-found` does not reserve or cancel a future prompt; the control plane owns cancellation intent and admission reconciliation. Transport loss alone does not cancel work.

The preset also mounts `@deepseek-ai/dsh-web-app/lain42-tools`. The relay defaults to `https://api.lain42.top/api/agent/bridge/v1/tool`; set `LAIN42_AGENT_TOOL_RELAY_URL` only to override it for another environment. The DSH service signs bounded requests with the existing `LAIN42_DSH_BRIDGE_SECRET`. New API verifies the HMAC and one-use nonce, resolves the DSH Session to its stored Lain42 account owner, and executes only the named read-only search, page-fetch, repository, issue, or pull-request operation. GitHub OAuth tokens stay in New API and are selected from the resolved account; they are never sent to DSH or the browser. Public page and repository contents remain untrusted model input. If the relay URL or shared secret is invalid, tools return an actionable service-unavailable result instead of disabling ordinary chat.

For account-billed models, this bundle also provides the optional `llmRequestHeaders` resolver for the `lain42-web` model route. Set the same independent `LAIN42_AGENT_MODEL_RELAY_SECRET` (at least 32 bytes) on DSH and New API, then configure that provider profile to use `https://api.lain42.top/v1/agent` and model ids enabled by New API. The resolver signs the server-owned DSH session id and selected model for each request; it never sends the relay secret to the browser. New API rejects calls without an active server-created Agent session mapping, so the control plane must provision and pass the private DSH session id server-side.

Keep this DSH process on a dedicated server instance bound to loopback or a private network, and let only the New API backend reach the route. The bridge authenticates New API as a trusted service; it does not replace New API's user/session ownership checks or make the DSH Web UI and its other APIs safe to publish. Do not enable it on a personal paired node such as the owner's A7A.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch layer plus the runtime glue plugin and the preset-scoped Lain42 account-tool plugin: `cordis.patch.yml` carries the host rows and the preset registry, and each `presets/<id>.patch.yml` inserts one shipped preset declaration, applied in the order `dsh.bundle.patch` lists them. The storage stack and projection cache come from `dsh-base`; the web overlay's workspace and message-feedback rows consume that shared `storageDomain` service. The patch restates the surface-specific values the base deliberately omits, inserts the web-only host rows and browser roster, then moves the agent plane behind presets. The glue plugin owns dist serving, trust sampling, prompt sections, the bash variable, and the readiness announcements. The Lain42 tool plugin is loaded only by its dedicated preset. The `office-to-pdf` row mounts one lazy [Office conversion provider](../../document/office-to-pdf/README.md) for Host consumers, including Desktop compositions using this bundle. The conversion service's Remote methods authorize preview reads, while Document Preview owns the Office viewer and Client cache.

### Patch semantics

A patch replaces the targeted row's whole `config`, so each web row restates every key it owns: the persona prefix and suffix templates, the `DSH_TOOLS_MODE` PTC mode opt-in, and the `session-query-sqlite` values on the base rows, then `insert` adds the web host rows, transport, and browser roster. The per-agent tool rows the base mounts process-wide are disabled here and the preset roster takes over; the reasoning for each host-plane versus preset-plane decision is inline in the patch.

### Readiness

The URL line and browser handoff are readiness signals: supervisors RPC as soon as they observe the line, and a browser requests the page as soon as it opens, so both run only after the Loader tree settles, the required-startup audit passes, and Connection authentication is available — or immediately in a hand-built tree without a Loader. Client combo JavaScript and source maps remain unmaterialized at this point. Optional plugin failures do not suppress readiness; a required startup failure or a tree disposed mid-boot announces nothing.

### LAN trust sampling

`resolveLanTrust` samples the network once at boot: a loopback bind (`127.0.0.1`) derives no LAN addresses, while an all-interfaces bind adds every non-internal IPv4 literal. The derived literals plus the explicit `--trusted-host` authorities form the `/api` browser-trust fence, and the printed LAN URL always matches that fence.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `web-app` glue plugin: dist resolution, LAN trust sampling, prompt sections, bash variable, URL line, browser handoff |
| [`src/lain42-bridge.ts`](src/lain42-bridge.ts) | The private HMAC-authenticated turn and original-request cancellation routes used by the Lain42 control plane |
| [`src/lain42-tools.ts`](src/lain42-tools.ts) | Preset-scoped read-only tools relayed through New API with per-account OAuth isolation |
| [`src/lain42-model-relay.ts`](src/lain42-model-relay.ts) | Session- and model-scoped signed headers for New API model requests |
| [`src/startup.ts`](src/startup.ts) | The `web-startup` provider: `--host`, `--port`, `--trusted-host`, `--no-open`, `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | The web patch: restated base values, web host rows, browser roster, preset registry |
| [`presets/`](presets) | One `@deepseek-ai/dsh-agent-preset` declaration per shipped preset (`standard`, `ptc`, `minimal`, `cordis`, and the four `lain42-web*` modes), each its own patch file |
| — | No runtime invariant companion is published; every contribution (frontend-static child plugin, prompt section, bashEnv registration) is registry-disposed with the fiber, and each owning registry's package carries that relation's invariant; the package holds no mutable state of its own to audit. |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | Dist resolution, fallback seat, prompt sections, readiness |
| [`tests/lain42-bridge.spec.ts`](tests/lain42-bridge.spec.ts) | Signed bridge requests, bounded input, durable turn results, and failure handling |
| [`tests/lain42-tools.spec.ts`](tests/lain42-tools.spec.ts) | Preset tool registration, session-bound requests, signatures, and safe relay failure |
| [`tests/lain42-model-relay.spec.ts`](tests/lain42-model-relay.spec.ts) | Model-relay signatures and invalid request handling |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN-trust sampling |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | Default-browser handoff after the page is reachable |

### Invariant ownership

No invariant companion is published because every contribution — the frontend-static child plugin, the prompt sections, and the bash variable registration — is registry-disposed with the fiber, and each owning registry package carries that relation's invariant.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the browser reload pipeline, or the built frontend.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the GUI runs on.
- [dsh-client-hmr](../../client/hmr/README.md) — how client-plugin changes reload during development.
- [frontend-static](../../host/frontend-static/README.md) — how the built frontend is served.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (first-party order 10100, after reusable instructions) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

Source and Web sections follow first-party reusable instructions. Different checkout paths or local ports leave that preceding prefix unchanged when tools and configuration match; provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Lain42 history window** — the private turn waiter opens the latest 50 messages. A request or its earlier Inbox insertion outside this window cannot be reconstructed; older-result lookup and hosted terminal-delivery reconciliation remain incomplete. A cancellation receipt alone is not a recovered result.


These limits tell you what to expect in unusual setups — a source checkout, SSH sessions, or strict networks. They are current package constraints, not a general browser comparison or a task backlog.

- **The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback.
- **LAN addresses are sampled once at startup** — interface changes after boot are not re-advertised; the printed LAN URL always matches what was sampled.
- **Only the handoff start is observable** — the GUI reports that the browser was asked to open, not that it actually opened; a later browser exit is never reported, and the printed URL is your manual fallback.
- **SSH sessions keep the URL but skip the browser handoff** — the printed URL names the remote host's loopback endpoint; the SSH client or editor must expose and open the local forwarded address.
- **`BROWSER` overrides only come from the environment** — a discovered `.env` cannot set `BROWSER`; only an inherited value can choose the executable for the automatic handoff.
- **Binding all network interfaces is not supported** — `--host 0.0.0.0` is rejected at startup for safety; use the default loopback host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The Web composition includes the account Remote controller and Account settings section.
