# Agent Note: ZeroStack ACP worker admission

Status: proposed

English | [中文](2026-09-25-zerostack-acp-worker-admission.zh.md)

## Problem

Lain42 needs device-local coding work without making its shared web service execute user tools on a common server. ZeroStack offers an external ACP agent with optional Cargo features, but resource cost alone does not establish that it is safe to connect to a browser-controlled worker.

## Proposal

Keep DeepSeek Harness (DSH) as the product runtime for web and mobile UI, identity, sessions, model routing, and tool policy. Treat ZeroStack only as an optional external ACP worker, launched through the existing [`subagent-acp` provider](../../../../packages/subagent/subagent-acp/README.md); do not link its Rust code into DSH or bundle its GPL-3.0-only binary until distribution obligations are reviewed.

The candidate profile is `--no-default-features --features acp`. GitHub Actions built and started this profile from upstream commit [`16fadb3b8f29238a5716eaf937ecf9d41a42f946`](https://github.com/gi-dellav/zerostack/commit/16fadb3b8f29238a5716eaf937ecf9d41a42f946), which was the upstream `main` head queried on 2026-09-25. Each run initialized ACP, created a session, then sampled process RSS 24 times over 4.8 seconds without making a model request:

| Runner | Default average / peak | Lean average / peak | ACP-only average / peak |
|---|---:|---:|---:|
| Linux ARM64 | 25,098 / 25,180 KiB | 22,441 / 22,520 KiB | 21,326 / 21,400 KiB |
| Linux x64 | 25,827 / 25,940 KiB | 25,763 / 25,892 KiB | 23,692 / 23,780 KiB |
| Windows x64 | 14,408 / 14,408 KiB | 14,356 / 14,356 KiB | 14,048 / 14,048 KiB |

These measurements make ACP-only a useful lean profile, with the clearest reduction on ARM64. They measure the worker after session creation, not the total DSH application, active inference, CPU load, or a production task. The measurement job is [GitHub Actions run 36090536954](https://github.com/lilyco-42/deepseek-harness/actions/runs/36090536954).

Do not expose ZeroStack as a web-controlled remote-write worker yet. Its ACP implementation automatically answers `Ask` permission requests with `AllowOnce`, its ACP path does not check the `--read-only` flag, and its security guide says the sandbox covers Bash while the agent's own file tools and MCP servers remain outside that sandbox ([permission implementation](https://github.com/gi-dellav/zerostack/blob/16fadb3b8f29238a5716eaf937ecf9d41a42f946/src/extras/acp/mod.rs), [security guide](https://github.com/gi-dellav/zerostack/blob/16fadb3b8f29238a5716eaf937ecf9d41a42f946/SECURITY.md)). A future web-to-device path must use one worker per account and a tested OS-level sandbox that exposes only that account's selected workspace and explicitly allowed network destinations. Keep user machines and the owner's private Radxa outside any shared-worker pool.

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
- GitHub Actions builds and exercises ACP session creation on Linux x64, Linux ARM64, and Windows x64 from a reviewed upstream pin; a same-runner benchmark compares a representative coding task and idle RSS with DSH.

## Risks

The RSS sample is a short idle measurement and is sensitive to runner and operating-system differences. It cannot establish end-to-end memory or CPU savings until DSH and ZeroStack run the same representative task on the same runners. A full cross-platform sandbox and GPL-compatible distribution model may cost more engineering than the measured savings justify.
