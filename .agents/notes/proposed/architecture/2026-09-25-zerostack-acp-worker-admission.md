# Agent Note: ZeroStack ACP worker admission

Status: proposed

English | [中文](2026-09-25-zerostack-acp-worker-admission.zh.md)

## Problem

Lain42 needs device-local coding work without making its shared web service execute user tools on a common server. ZeroStack offers an external ACP agent with optional Cargo features, but resource cost alone does not establish that it is safe to connect to a browser-controlled worker.

## Proposal

Keep DeepSeek Harness (DSH) as the product runtime for web and mobile UI, identity, sessions, model routing, and tool policy. Treat ZeroStack only as an optional external ACP worker; do not link its Rust code into DSH or bundle its GPL-3.0-only binary until distribution obligations are reviewed. DSH's existing [`subagent-acp` provider](../../../../packages/subagent/subagent-acp/README.md) is a local process boundary: it can launch ZeroStack only on the same machine that hosts the DSH runtime. It does not route ACP to a paired user's device. Therefore, a cloud-hosted web Agent must not configure this provider to start ZeroStack on the shared application server and call that “user-local.” The browser-to-user-device product path needs a separate, authenticated per-account node transport that starts a fixed, administrator-installed worker on that user's paired node. The browser must not choose arbitrary executables, arguments, working directories, or environment values. Until that transport exists and is isolated, ZeroStack is suitable only as a user-operated local experiment.

The candidate profile is `--no-default-features --features acp`. GitHub Actions built and started this profile from upstream commit [`16fadb3b8f29238a5716eaf937ecf9d41a42f946`](https://github.com/gi-dellav/zerostack/commit/16fadb3b8f29238a5716eaf937ecf9d41a42f946), which was the upstream `main` head queried on 2026-09-25. Each run initialized ACP, created a session, then sampled process RSS 24 times over 4.8 seconds without making a model request:

| Runner | Default average / peak | Lean average / peak | ACP-only average / peak |
|---|---:|---:|---:|
| Linux ARM64 | 25,102 / 25,184 KiB | 22,425 / 22,504 KiB | 21,330 / 21,404 KiB |
| Linux x64 | 25,959 / 26,072 KiB | 25,764 / 25,896 KiB | 23,581 / 23,672 KiB |
| Windows x64 | 14,460 / 14,460 KiB | 14,332 / 14,332 KiB | 14,036 / 14,036 KiB |

These measurements make ACP-only a useful lean profile, with the clearest reduction on ARM64. They measure the worker after session creation, not the total DSH application, active inference, CPU load, or a production task; they are not evidence of end-to-end savings versus DSH. All nine build-and-smoke jobs passed in [GitHub Actions run 36112963016](https://github.com/lilyco-42/deepseek-harness/actions/runs/36112963016). Its source audit still reports ACP Ask auto-approval and blocks remote writes.

ZeroStack's custom OpenAI provider accepts a configured base URL and an API-key environment variable; custom base URLs default to Chat Completions ([provider configuration](https://github.com/gi-dellav/zerostack/blob/main/docs/CONFIG.md#openai-api-styles-and-custom-headers)). This makes an OpenAI-compatible Lain42 `/v1` endpoint a plausible per-user model route. The mock-gateway smoke now covers `/models`, missing-key rejection, and bearer-authenticated streaming `/chat/completions` in [GitHub Actions run 36140336554](https://github.com/lilyco-42/deepseek-harness/actions/runs/36140336554). This proves protocol compatibility with a synthetic gateway only; it does not verify a real model provider or user credential. Before advertising a live connection, verify one user-issued scoped key against the real gateway outside CI. Keep that key on the user's own node, never in the shared server config or browser bundle.

The same run built and started ACP-only (`--no-default-features --features acp`) on Linux x64, Linux ARM64, Windows x64, and Windows ARM64. Each smoke initialized ACP, created a session, exercised the mock gateway, and sampled process RSS 24 times over 4.8 seconds while idle and after mock inference:

| Runner | Idle average / peak | After mock inference average / peak |
|---|---:|---:|
| Linux x64 | 23,800 / 23,800 KiB | 23,092 / 23,092 KiB |
| Linux ARM64 | 21,326 / 21,400 KiB | 21,140 / 21,140 KiB |
| Windows x64 | 14,168 / 14,168 KiB | 15,836 / 15,836 KiB |
| Windows ARM64 | 14,428 / 14,652 KiB | 15,756 / 15,956 KiB |

All ten build-and-smoke jobs in run 36140336554 passed. These short runner samples do not include a real model, representative coding work, or a same-runner DSH comparison, so they establish a small worker footprint but not end-to-end savings. The source audit still reports that ACP automatically approves `Ask`; remote write execution remains blocked.

Do not expose ZeroStack as a web-controlled remote-write worker yet. Its ACP implementation automatically answers `Ask` permission requests with `AllowOnce`, its ACP path does not check the `--read-only` flag, and its security guide says the sandbox covers Bash while the agent's own file tools and MCP servers remain outside that sandbox ([permission implementation](https://github.com/gi-dellav/zerostack/blob/16fadb3b8f29238a5716eaf937ecf9d41a42f946/src/extras/acp/mod.rs), [security guide](https://github.com/gi-dellav/zerostack/blob/16fadb3b8f29238a5716eaf937ecf9d41a42f946/SECURITY.md)). Version note: v1.7.2's release notes mention PR #212 as “fail closed on Ask in headless mode,” but that change targets the non-interactive `-p` CLI dispatch. The tagged ACP permission function still creates an Ask channel and answers requests with `AllowOnce` ([PR #212](https://github.com/gi-dellav/zerostack/pull/212), [v1.7.2 ACP source](https://github.com/gi-dellav/zerostack/blob/v1.7.2/src/extras/acp/mod.rs)). Do not treat that changelog item as an ACP security fix. A future web-to-device path must use one worker per account and a tested OS-level sandbox that exposes only that account's selected workspace and explicitly allowed network destinations. Keep user machines and the owner's private Radxa outside any shared-worker pool.

## Alternatives considered

**Keep DSH as the only worker.** Rejected as the only long-term option because it gives up a smaller standalone ACP worker; retain DSH as the default product and policy host.

**Replace DSH with ZeroStack.** Rejected because ZeroStack does not provide Lain42's web/mobile product, account isolation, sessions, or model gateway, and its current ACP permission behavior is not suitable for remote writes.

**Embed or bundle ZeroStack now.** Rejected because the measured memory savings are modest on x64 and Windows, its license is `GPL-3.0-only`, and an in-process integration would add avoidable coupling while bypassing the existing process seam.

**Enable remote writes with read-only configuration alone.** Rejected because ACP does not enforce the CLI read-only flag and the upstream sandbox does not confine all file and MCP operations.

## Acceptance criteria

- ACP permission requests are forwarded to a human-controlled DSH approval path or fail closed; no worker silently grants a request.
- A per-account OS sandbox proves that reads and writes outside the selected workspace are denied, including through direct file tools, subprocesses, MCP, and symlinks or equivalent filesystem escapes.
- Worker credentials and environment are isolated per user; a web request cannot launch or address another user's process or workspace.
- GPL-3.0-only use, notices, and binary distribution are reviewed before Lain42 downloads or bundles ZeroStack for users.
- GitHub Actions builds and exercises ACP session creation on Linux x64, Linux ARM64, Windows x64, and Windows ARM64 from the reviewed upstream pin; a same-runner benchmark comparing a representative coding task and RSS with DSH remains outstanding.
- A browser/phone request can reach only the authenticated user's paired node through the dedicated node transport; the cloud app process never launches a user-selected command or receives another user's workspace path.

## Risks

The RSS sample uses short idle and synthetic-inference windows and is sensitive to runner and operating-system differences. It cannot establish end-to-end memory or CPU savings until DSH and ZeroStack run the same representative task on the same runners. The existing local subprocess provider is not the missing cloud-to-device transport. A full cross-platform sandbox and GPL-compatible distribution model may cost more engineering than the measured savings justify.
