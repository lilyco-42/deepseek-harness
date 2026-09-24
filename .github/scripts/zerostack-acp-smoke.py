"""Smoke-test the pinned ZeroStack ACP process and sample its resident memory."""

from __future__ import annotations

import csv
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ZERO_STACK = ROOT / "zerostack" / "target" / "release" / (
    "zerostack.exe" if os.name == "nt" else "zerostack"
)
ACP_SOURCE = ROOT / "zerostack" / "src" / "extras" / "acp" / "mod.rs"
SAMPLES = 24
SAMPLE_INTERVAL_SECONDS = 0.2


def read_stdout(process: subprocess.Popen[str], lines: queue.Queue[str | None]) -> None:
    assert process.stdout is not None
    for line in process.stdout:
        lines.put(line)
    lines.put(None)


def read_stderr(process: subprocess.Popen[str], tail: deque[str]) -> None:
    assert process.stderr is not None
    for line in process.stderr:
        tail.append(line.rstrip())


def request(
    process: subprocess.Popen[str],
    lines: queue.Queue[str | None],
    request_id: int,
    method: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        + "\n"
    )
    process.stdin.flush()

    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ZeroStack ACP exited with code {process.returncode}")
        try:
            line = lines.get(timeout=0.25)
        except queue.Empty:
            continue
        if line is None:
            raise RuntimeError("ZeroStack ACP closed stdout before replying")
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError("ZeroStack wrote non-JSON data to ACP stdout") from error
        if not isinstance(frame, dict) or frame.get("id") != request_id:
            continue
        if "error" in frame:
            raise RuntimeError(f"ZeroStack ACP rejected {method}: {frame['error']}")
        result = frame.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"ZeroStack ACP returned no result for {method}")
        return result
    raise TimeoutError(f"ZeroStack ACP timed out during {method}")


def resident_kib(pid: int) -> int | None:
    if sys.platform.startswith("linux"):
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
        match = re.search(r"^VmRSS:\s+(\d+)\s+kB$", status, re.MULTILINE)
        return int(match.group(1)) if match else None

    if os.name == "nt":
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            check=True,
            capture_output=True,
            text=True,
        )
        rows = list(csv.reader(result.stdout.splitlines()))
        if not rows or len(rows[0]) < 5 or rows[0][1] != str(pid):
            return None
        value = re.sub(r"[^0-9]", "", rows[0][4])
        return int(value) if value else None

    return None


def acp_permission_posture() -> str:
    source = ACP_SOURCE.read_text(encoding="utf-8")
    start = source.find("fn build_acp_permission")
    end = source.find("pub(crate) fn resolve_acp_mode", start)
    if start < 0 or end < 0:
        return "NOT VERIFIED (permission implementation shape changed)"
    permission_implementation = source[start:end]
    if "UserDecision::AllowOnce" in permission_implementation:
        return "FAIL: ACP automatically approves Ask permissions"
    return "NOT VERIFIED (requires review of the changed permission implementation)"


def main() -> None:
    if not ZERO_STACK.is_file():
        raise FileNotFoundError(f"ZeroStack binary not found: {ZERO_STACK}")

    environment = os.environ.copy()
    # Session creation does not call a model. The placeholder keeps provider
    # initialization deterministic without exposing or consuming a credential.
    environment["OPENROUTER_API_KEY"] = "zerostack-ci-placeholder"
    output_lines: queue.Queue[str | None] = queue.Queue()
    stderr_tail: deque[str] = deque(maxlen=20)

    with tempfile.TemporaryDirectory(prefix="zerostack-acp-smoke-") as workspace:
        process = subprocess.Popen(
            [str(ZERO_STACK), "--acp"],
            cwd=workspace,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        threading.Thread(
            target=read_stdout, args=(process, output_lines), daemon=True
        ).start()
        threading.Thread(
            target=read_stderr, args=(process, stderr_tail), daemon=True
        ).start()

        try:
            request(
                process,
                output_lines,
                1,
                "initialize",
                {"protocolVersion": 1, "clientCapabilities": {}},
            )
            request(
                process,
                output_lines,
                2,
                "session/new",
                {"cwd": workspace, "mcpServers": []},
            )

            samples = []
            for _ in range(SAMPLES):
                if process.poll() is not None:
                    raise RuntimeError("ZeroStack ACP exited during the memory sample")
                rss = resident_kib(process.pid)
                if rss is not None:
                    samples.append(rss)
                time.sleep(SAMPLE_INTERVAL_SECONDS)

            if not samples:
                raise RuntimeError("The runner did not provide a resident-memory reading")

            peak_kib = max(samples)
            average_kib = round(sum(samples) / len(samples))
            permission_posture = acp_permission_posture()
            machine = os.uname().machine if hasattr(os, "uname") else "windows"
            summary = (
                f"### ZeroStack ACP smoke: {sys.platform} / {machine}\n\n"
                f"- Pinned upstream revision: `36dddf038941978a6079762bb2799ec7e44504de`\n"
                f"- ACP initialize + session/new: passed\n"
                f"- ACP permission posture: **{permission_posture}**\n"
                "- Remote write eligibility: **blocked until permissions fail closed**\n"
                f"- Resident memory after session creation ({len(samples)} samples over 4.8s): "
                f"average {average_kib} KiB, peak {peak_kib} KiB\n"
            )
            print(summary)
            summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
            if summary_path:
                with open(summary_path, "a", encoding="utf-8") as summary_file:
                    summary_file.write(summary + "\n")
        finally:
            if process.stdin is not None:
                process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                raise RuntimeError("ZeroStack ACP did not stop after stdin closed") from None

        if process.returncode != 0:
            details = "\n".join(stderr_tail)
            raise RuntimeError(
                f"ZeroStack ACP exited with code {process.returncode}"
                + (f"\n{details}" if details else "")
            )


if __name__ == "__main__":
    main()
