"""Fail closed for Ask decisions in the pinned ZeroStack ACP worker."""

from pathlib import Path


source_path = Path("zerostack/src/extras/acp/mod.rs")
source = source_path.read_text(encoding="utf-8")
unsafe = """    // ACP is headless — there is no interactive user to prompt. Auto-approve
    // Ask requests so tools don't fail with "Permission system unavailable".
    // Log a warning so the auto-approval is visible in logs.
    tokio::spawn(async move {
        while let Some(req) = ask_rx.recv().await {
            tracing::warn!(
                "ACP auto-approving tool call: tool={}, input_len={}",
                req.tool,
                req.input.len()
            );
            let _ = req
                .reply
                .send(crate::permission::ask::UserDecision::AllowOnce);
        }
    });"""
safe = """    // ACP Ask decisions are denied until the client approval protocol is wired
    // end to end. A headless worker must not grant a side effect by itself.
    tokio::spawn(async move {
        while let Some(req) = ask_rx.recv().await {
            tracing::warn!(
                "ACP denying unapproved tool call: tool={}, input_len={}",
                req.tool,
                req.input.len()
            );
            let _ = req
                .reply
                .send(crate::permission::ask::UserDecision::Deny);
        }
    });"""

if source.count(unsafe) != 1:
    raise RuntimeError("Pinned ZeroStack ACP permission code changed; refusing to patch")
source_path.write_text(source.replace(unsafe, safe), encoding="utf-8")
