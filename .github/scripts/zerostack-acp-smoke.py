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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
ZERO_STACK = ROOT / "zerostack" / "target" / "release" / (
    "zerostack.exe" if os.name == "nt" else "zerostack"
)
ACP_SOURCE = ROOT / "zerostack" / "src" / "extras" / "acp" / "mod.rs"
UPSTREAM_REVISION = "16fadb3b8f29238a5716eaf937ecf9d41a42f946"
PROFILE = os.environ.get("ZERO_STACK_PROFILE", "default")
SAMPLES = 24
SAMPLE_INTERVAL_SECONDS = 0.2
MOCK_API_KEY = "zerostack-ci-synthetic-key"
MOCK_MODEL = "lain42-ci-mock"
MOCK_REPLY = "Lain42 mock gateway connected."


class MockGateway:
    """A local OpenAI-compatible endpoint that never contacts a real provider."""

    def __init__(self) -> None:
        self.model_requests: list[dict[str, Any]] = []
        self.chat_requests: list[dict[str, Any]] = []
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def send_json(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def authorized(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {MOCK_API_KEY}"

            def do_GET(self) -> None:
                if self.path not in ("/models", "/v1/models"):
                    self.send_json(404, {"error": {"message": "unknown endpoint"}})
                    return
                allowed = self.authorized()
                gateway.model_requests.append({"path": self.path, "authorized": allowed})
                if not allowed:
                    self.send_json(401, {"error": {"message": "invalid mock key"}})
                    return
                self.send_json(
                    200,
                    {
                        "object": "list",
                        "data": [{"id": MOCK_MODEL, "object": "model", "context_length": 4096}],
                    },
                )

            def do_POST(self) -> None:
                if self.path not in ("/chat/completions", "/v1/chat/completions"):
                    self.send_json(404, {"error": {"message": "unknown endpoint"}})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    payload = json.loads(self.rfile.read(length))
                except (ValueError, json.JSONDecodeError):
                    self.send_json(400, {"error": {"message": "invalid JSON"}})
                    return
                allowed = self.authorized()
                gateway.chat_requests.append(
                    {"path": self.path, "authorized": allowed, "payload": payload}
                )
                if not allowed:
                    self.send_json(401, {"error": {"message": "invalid mock key"}})
                    return
                if payload.get("model") != MOCK_MODEL:
                    self.send_json(400, {"error": {"message": "unexpected model"}})
                    return
                if payload.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    frames = (
                        {"id": "mock", "object": "chat.completion.chunk", "model": MOCK_MODEL,
                         "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
                        {"id": "mock", "object": "chat.completion.chunk", "model": MOCK_MODEL,
                         "choices": [{"index": 0, "delta": {"content": MOCK_REPLY}, "finish_reason": None}]},
                        {"id": "mock", "object": "chat.completion.chunk", "model": MOCK_MODEL,
                         "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    )
                    for frame in frames:
                        self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.send_json(
                    200,
                    {
                        "id": "mock",
                        "object": "chat.completion",
                        "model": MOCK_MODEL,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": MOCK_REPLY},
                                "finish_reason": "stop",
                            }
                        ],
                    },
                )

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def verify_mock_model_list(gateway: MockGateway) -> None:
    authorized = Request(
        f"{gateway.base_url}/models",
        headers={"Authorization": f"Bearer {MOCK_API_KEY}"},
    )
    with urlopen(authorized, timeout=5) as response:
        payload = json.loads(response.read())
    model_ids = [item.get("id") for item in payload.get("data", [])]
    if MOCK_MODEL not in model_ids:
        raise RuntimeError("The mock gateway model-list endpoint omitted the selected model")

    unauthorized = Request(f"{gateway.base_url}/models")
    try:
        with urlopen(unauthorized, timeout=5):
            raise RuntimeError("The mock gateway accepted a model-list request without a key")
    except HTTPError as error:
        if error.code != 401:
            raise RuntimeError("The mock gateway rejected an unauthenticated request incorrectly") from error
    if len(gateway.model_requests) != 2 or gateway.model_requests[0]["authorized"] is not True:
        raise RuntimeError("The mock gateway model-list authentication checks were not recorded")
    if gateway.model_requests[1]["authorized"] is not False:
        raise RuntimeError("The mock gateway did not reject the missing API key")


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
    notifications: list[dict[str, Any]] | None = None,
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
        if not isinstance(frame, dict):
            continue
        if frame.get("id") != request_id:
            if notifications is not None and "method" in frame:
                notifications.append(frame)
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


def sample_resident_kib(pid: int) -> list[int]:
    samples: list[int] = []
    for _ in range(SAMPLES):
        rss = resident_kib(pid)
        if rss is not None:
            samples.append(rss)
        time.sleep(SAMPLE_INTERVAL_SECONDS)
    return samples


def acp_permission_posture() -> str:
    source = ACP_SOURCE.read_text(encoding="utf-8")
    start = source.find("fn build_acp_permission")
    end = source.find("pub(crate) fn resolve_acp_mode", start)
    if start < 0 or end < 0:
        return "NOT VERIFIED (permission implementation shape changed)"
    permission_implementation = source[start:end]
    if "UserDecision::AllowOnce" in permission_implementation:
        return "VERIFIED UNSAFE: ACP automatically approves Ask permissions"
    return "NOT VERIFIED (requires review of the changed permission implementation)"


def acp_read_only_posture() -> str:
    source = ACP_SOURCE.read_text(encoding="utf-8")
    has_readonly_config = '"readonly" => SecurityMode::ReadOnly' in source
    checks_readonly_flag = "cli.read_only" in source
    if has_readonly_config and not checks_readonly_flag:
        return "readonly config is supported; the --read-only CLI flag is not checked by ACP"
    if has_readonly_config:
        return "readonly config and --read-only CLI flag are present; verify behavior"
    return "NOT VERIFIED (requires review of the changed ACP mode resolver)"


def acp_workspace_posture() -> str:
    source = ACP_SOURCE.read_text(encoding="utf-8")
    if "the ACP server never chdirs to it" in source:
        return "process working directory; start one ACP process per workspace"
    return "NOT VERIFIED (requires review of ACP workspace handling)"


def main() -> None:
    if not ZERO_STACK.is_file():
        raise FileNotFoundError(f"ZeroStack binary not found: {ZERO_STACK}")

    gateway = MockGateway()
    gateway.start()
    try:
        verify_mock_model_list(gateway)
        with tempfile.TemporaryDirectory(prefix="zerostack-acp-smoke-") as root:
            workspace = Path(root) / "workspace"
            config_dir = Path(root) / "config"
            workspace.mkdir()
            config_dir.mkdir()
            (config_dir / "config.toml").write_text(
                "\n".join(
                    (
                        'provider = "lain42-ci"',
                        f'model = "{MOCK_MODEL}"',
                        'default_permission_mode = "readonly"',
                        "no_tools = true",
                        "",
                        "[custom_providers.lain42-ci]",
                        'provider_type = "openai"',
                        f'base_url = "{gateway.base_url}"',
                        'api_key_env = "LAIN42_MOCK_API_KEY"',
                        'api_style = "completions"',
                        f'model = "{MOCK_MODEL}"',
                        "",
                    )
                ),
                encoding="utf-8",
            )

            environment = os.environ.copy()
            environment["ZS_CONFIG_DIR"] = str(config_dir)
            environment["LAIN42_MOCK_API_KEY"] = MOCK_API_KEY
            output_lines: queue.Queue[str | None] = queue.Queue()
            stderr_tail: deque[str] = deque(maxlen=20)
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
                session = request(
                    process,
                    output_lines,
                    2,
                    "session/new",
                    {"cwd": str(workspace), "mcpServers": []},
                )
                session_id = session.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    raise RuntimeError("ZeroStack ACP returned no sessionId")

                idle_samples = sample_resident_kib(process.pid)
                if not idle_samples:
                    raise RuntimeError("The runner did not provide resident-memory readings")

                notifications: list[dict[str, Any]] = []
                response = request(
                    process,
                    output_lines,
                    3,
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [
                            {
                                "type": "text",
                                "text": "Reply with this exact confirmation: " + MOCK_REPLY,
                            }
                        ],
                    },
                    notifications,
                )
                response_text = json.dumps(
                    {"response": response, "notifications": notifications},
                    ensure_ascii=False,
                )
                if MOCK_REPLY not in response_text:
                    raise RuntimeError("ACP did not stream the mock gateway reply")
                if not gateway.chat_requests or not all(
                    item["authorized"] for item in gateway.chat_requests
                ):
                    raise RuntimeError("The mock gateway did not receive an authorized chat request")
                if any(
                    item["payload"].get("model") != MOCK_MODEL
                    or item["payload"].get("stream") is not True
                    for item in gateway.chat_requests
                ):
                    raise RuntimeError("ZeroStack sent an unexpected model or non-streaming chat request")

                model_samples = sample_resident_kib(process.pid)
                if not model_samples:
                    raise RuntimeError("The runner did not provide post-inference memory readings")

                permission_posture = acp_permission_posture()
                read_only_posture = acp_read_only_posture()
                workspace_posture = acp_workspace_posture()
                unverified_postures = [
                    posture
                    for posture in (permission_posture, read_only_posture, workspace_posture)
                    if posture.startswith("NOT VERIFIED")
                ]
                if unverified_postures:
                    raise RuntimeError(
                        "ZeroStack ACP security source changed and requires review: "
                        + "; ".join(unverified_postures)
                    )
                machine = os.uname().machine if hasattr(os, "uname") else "windows"
                summary = (
                    f"### ZeroStack ACP smoke: {sys.platform} / {machine}\n\n"
                    f"- Pinned upstream revision: `{UPSTREAM_REVISION}`\n"
                    f"- Cargo profile: `{PROFILE}`\n"
                    "- ACP initialize + session/new + session/prompt: passed\n"
                    "- Gateway model list + missing-key rejection + ZeroStack bearer-auth streaming: passed\n"
                    f"- ACP permission posture: **{permission_posture}**\n"
                    f"- ACP read-only configuration: {read_only_posture}\n"
                    f"- ACP workspace selection: {workspace_posture}\n"
                    "- Remote write eligibility: **blocked until permissions fail closed**\n"
                    f"- Idle resident memory ({len(idle_samples)} samples over 4.8s): "
                    f"average {round(sum(idle_samples) / len(idle_samples))} KiB, "
                    f"peak {max(idle_samples)} KiB\n"
                    f"- Post-inference resident memory ({len(model_samples)} samples over 4.8s): "
                    f"average {round(sum(model_samples) / len(model_samples))} KiB, "
                    f"peak {max(model_samples)} KiB\n"
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
    finally:
        gateway.stop()


if __name__ == "__main__":
    main()
