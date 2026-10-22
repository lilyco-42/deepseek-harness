# LYCO AI Studio — isolated Harness-style client

This integration lives in the existing `lilyco-42/deepseek-harness` fork on its own feature branch. It **does not start the full DeepSeek Harness agent host**. The upstream Host can execute tools, commands, filesystem operations and plugins; deploying that privileged runtime to anonymous paid users would be unsafe. This integration adapts its three-pane chat / trajectory interaction into a **read-only API client** for the existing LYCO metered server.

## Routes and contracts

Host the directory's static files at `https://lain42.top/ai-harness/` with the same origin as these pre-existing backend routes:

- `POST /studio/api/login` — website login, returns a JWT and website user;
- `GET /studio/api/points` — canonical wallet/points ledger and account profile;
- `POST /studio/api/points/topup` — official USDT top-up order (requires explicit click);
- `POST /ai-api/chat` — JWT-authenticated, metered server-side model call;
- `GET /ai-api/model-status` — board inference health.

The model API key never enters the browser. The browser sends only the website JWT to the existing LYCO proxy. Billing reserves, settles, and refunds points **on the server**. No mock balance, client-side charge calculation, new billing database, or direct Radxa endpoint.

## Client-side call trace

IndexedDB `lyco_harness_client_v1` stores bounded `calls` and `sessions`, including request start/end timestamps, duration, model, selected conversation, messages, response/error, HTTP code, request/response IDs, prompt/completion/total tokens and settled points. Records are available offline for search/inspection and JSON export. **TTFT is not claimed** because the metered endpoint currently buffers responses. Logs never include passwords, site JWT, or model API keys. User prompts and responses **are sensitive** and stay in this browser's IndexedDB unless the user explicitly exports them; clearing local logs deletes that local history.

The client is intentionally tool-free: there is no shell, filesystem, SDK, subprocess or plugin execution. As Harness's event-based Trajectory depends on its privileged Host/session runtime, this implementation offers an honest client-side request ledger, **not a drop-in replacement for core SessionEvents or full Agent Harness telemetry**.

## Deployment / rollback

Serve as an isolated preview path first and verify actual model quality + refunds before linking from the production chat page. No production files are overwritten by creating this branch. Keep `/ai-api/chat` as fallback.

At release, verify: protected routes 401 without JWT, login/balance, one isolated-metered generation, no raw `/no_think`, loop rejection/refund, mobile interactions, empty-session and export/delete behavior. Do not put model API secrets in a frontend bundle.

## Model repair prerequisite

The existing Python gateway was discovered injecting `/no_think` into **Qwen2.5** user messages and running llama.cpp with default repetition penalty 1.0. Repair these server-side first; a new UI cannot correct a broken decode loop. Existing 1.5B GGUF may still hallucinate after tuning, and 3B Q4_K_M is only a candidate pending A7A quality/memory testing.

Upstream DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness — MIT, experimental, not audited. This client does not claim upstream certification or its Agent Tool security model.

## V2 redesign and preview

The v2 UI uses `harness-v2.css` as an additive layer on `style.css`, and focuses on a dialogue-centered grey/graphite interface. It keeps the compatible and privileged-free backend routes above. Features: desktop/mobile conversation-first layout, sessions in left rail, client trace timeline, points panel, local request duration, accessible light/dark toggle, safe Markdown rendering and fenced code blocks. The standalone preview route is:

`https://lain42.top/ai-api/harness/v2/`

Deployment is versioned and isolated under `/opt/lyco-ai-gateway/harness-preview/v2/`, with `/ai-api/harness/` retained as previous preview and `/ai-api/chat` as legacy fallback. Pin the reviewed vendor bundles of **Marked 15.0.12** and **DOMPurify 3.2.6** locally under `vendor/`; retain their separate open-source license notices when packaging. CSP only permits first-party JS, CSS, and same-origin API calls. Sanitization forbids active/embedded HTML before insertion. Never render raw Markdown with `innerHTML` except after sanitization.

Client events store request sent, response received, official billing result, and completion/failure, with timestamps and duration. Missing billing fields are displayed as unknown rather than fabricated zero. The client never claims true streamed TTFT. Ctrl/⌘+K begins a new session (unless blocked by an active request).

## GitHub OAuth on the separate New API console

The `api.lain42.top` GitHub login error is a **different** app issue than this preview. On 2026-10-22 the New API container was configured with HTTP_PROXY and HTTPS_PROXY pointing to `http://172.18.0.1:1081`, but sing-box on the host only listened on `127.0.0.1:1081`. GitHub OAuth logs reported `proxyconnect tcp ... connect: connection refused`. The VPS and a direct container probe could reach GitHub without those proxy variables. The cautious fix is to remove those two stale environment variables in `/opt/new-api/docker-compose.prod.yml`, validate Compose, rebuild only `new-api`, and reverify the actual callback exchange. **This login fix is not completed until the remote control node comes back online and the change is applied.** Do not reproduce OAuth codes or secrets in logs/artifacts.
