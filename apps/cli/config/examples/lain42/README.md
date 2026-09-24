# Lain42 Agent: revised delivery goal

English | [中文](README.zh.md)

Use DeepSeek Harness as the Agent runtime, with Lain42 as its default model gateway. A user can chat from a phone or browser and invoke tools on **that user's own** paired headless node. The owner's Radxa A7A is private and must never be the shared execution host for other users.

This is an opt-in first slice, not a public deployment. The upstream `dsh web` surface is a local, process-token-authenticated single-user application. Public multi-user access requires a separate Lain42 control plane that authenticates each user, maps each session to exactly one owned device, forwards only authorized Agent events, and never exposes the device's local Web port or credentials.

## Current first slice

`cordis.patch.yml` routes the default model through the existing OpenAI-compatible Lain42 API using the official `llm-pi-ai` adapter. The model id and API key come from the node owner's environment; no credential is committed. It disables the official DeepSeek model and search adapters and the stock session-log/telemetry exports. Public URL fetch remains available. Search needs an independently configured provider and is **not ready** in this slice.

On a private node with `dsh` installed and a model id that exists in that user's Lain42 account:

```sh
export LAIN42_MODEL='<available-model-id>'
export LAIN42_API_KEY='<your-own-lain42-token>'
dsh web --no-open --patch /path/to/cordis.patch.yml
```

The optional `LAIN42_API_BASE_URL` overrides the default `https://api.lain42.top/v1` for controlled testing. Never put a token in the overlay, a URL, a browser page, or a shared server environment. Do not expose the local Web port to the internet.

## Acceptance before replacing the existing site Agent

1. A real model call through Lain42 answers “DeepSeek 是什么？” accurately, and a follow-up stays on the same topic. A 30-case conversation regression set also checks short messages, failed turns, and cited web results.
2. The model can fetch a supplied public URL and cite content actually fetched. Search either returns verifiable sources or clearly says it is unavailable; it must never invent results.
3. Browser GitHub OAuth reads the user's repositories without requiring `gh auth login`. A local `gh` call runs only on that user's paired node, with the executed path visible to the user.
4. Two accounts cannot read each other's sessions, files, credentials, devices, or tools. The owner-only Radxa remains inaccessible to the other account.
5. GitHub Actions builds and runs the relevant tests. Mobile browser and offline/reconnect scenarios are verified against a staging deployment before public rollout.

Until all five pass, the existing `/agent` page is not replaced and the work is not marked complete.
