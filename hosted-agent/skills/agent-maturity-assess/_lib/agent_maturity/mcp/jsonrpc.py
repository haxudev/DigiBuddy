from __future__ import annotations

import io
import json
import sys
import threading
import time
import traceback
from typing import Any, Callable, Dict, Optional


PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class Connection:
    MAX_NESTING_DEPTH = 25

    def __init__(self, stdin: Any = None, stdout: Any = None, stderr: Any = None) -> None:
        self.stdin = self._configure_input(stdin if stdin is not None else sys.stdin)
        self.stdout = self._configure_output(stdout if stdout is not None else sys.stdout)
        self.stderr = stderr if stderr is not None else sys.stderr
        self._next_request_id = 1
        self._pending_responses: Dict[Any, Dict[str, Any]] = {}
        self._dispatch: Optional[Callable[[str, Any, bool], Any]] = None
        self._local = threading.local()

    def send_result(self, request_id: Any, result: Any) -> None:
        self._send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def send_error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: Dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._send({"jsonrpc": "2.0", "id": request_id, "error": error})

    def send_notification(self, method: str, params: Any = None) -> None:
        message: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def request(self, method: str, params: Any = None, timeout: Optional[float] = None) -> Any:
        if self._dispatch is None:
            raise RuntimeError("Connection.request requires serve_forever to set a dispatch handler")
        depth = getattr(self._local, "depth", 0)
        if depth >= self.MAX_NESTING_DEPTH:
            raise RpcError(INTERNAL_ERROR, "JSON-RPC request nesting limit exceeded")

        request_id = self._next_request_id
        self._next_request_id += 1
        message: Dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

        if request_id in self._pending_responses:
            response = self._pending_responses.pop(request_id)
            return self._response_value(response)

        deadline = None if timeout is None else time.monotonic() + timeout
        self._local.depth = depth + 1
        try:
            while True:
                # A nested frame may have read this frame's response and parked
                # it, so re-check every iteration rather than only before the
                # loop, or the outer call blocks forever on an answer that has
                # already arrived.
                if request_id in self._pending_responses:
                    return self._response_value(self._pending_responses.pop(request_id))
                if deadline is not None and time.monotonic() > deadline:
                    raise RpcError(INTERNAL_ERROR, "JSON-RPC request timed out")
                line = self.stdin.readline()
                if line == "":
                    raise RpcError(INTERNAL_ERROR, "EOF while waiting for JSON-RPC response")
                response = self._handle_line(line, self._dispatch, waiting_for=request_id)
                if response is not None:
                    return self._response_value(response)
        finally:
            self._local.depth = depth

    def serve_forever(self, dispatch: Callable[[str, Any, bool], Any]) -> None:
        self._dispatch = dispatch
        while True:
            line = self.stdin.readline()
            if line == "":
                return
            self._handle_line(line, dispatch)

    def log(self, *parts: Any) -> None:
        text = " ".join(str(part) for part in parts)
        self.stderr.write(text + "\n")
        flush = getattr(self.stderr, "flush", None)
        if flush is not None:
            flush()

    def log_traceback(self) -> None:
        self.stderr.write(traceback.format_exc())
        flush = getattr(self.stderr, "flush", None)
        if flush is not None:
            flush()

    def _handle_line(
        self,
        line: str,
        dispatch: Callable[[str, Any, bool], Any],
        waiting_for: Any = None,
    ) -> Optional[Dict[str, Any]]:
        try:
            message = json.loads(line)
        except Exception:
            self.send_error(None, PARSE_ERROR, "Parse error")
            return None

        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self.send_error(message.get("id") if isinstance(message, dict) else None, INVALID_REQUEST, "Invalid Request")
            return None

        if "method" in message:
            self._handle_inbound_call(message, dispatch)
            return None

        if "id" in message and ("result" in message or "error" in message):
            if waiting_for is not None and message.get("id") == waiting_for:
                return message
            self._pending_responses[message.get("id")] = message
            return None

        self.send_error(message.get("id"), INVALID_REQUEST, "Invalid Request")
        return None

    def _handle_inbound_call(self, message: Dict[str, Any], dispatch: Callable[[str, Any, bool], Any]) -> None:
        method = message.get("method")
        if not isinstance(method, str):
            self.send_error(message.get("id"), INVALID_REQUEST, "Invalid Request")
            return
        params = message.get("params", {})
        is_notification = "id" not in message
        try:
            result = dispatch(method, params, is_notification)
            if not is_notification:
                self.send_result(message.get("id"), {} if result is None else result)
        except RpcError as exc:
            if not is_notification:
                self.send_error(message.get("id"), exc.code, exc.message, exc.data)
            else:
                self.log("notification error:", exc.message)
        except Exception as exc:
            self.log_traceback()
            if not is_notification:
                self.send_error(message.get("id"), INTERNAL_ERROR, str(exc))
        except (SystemExit, GeneratorExit) as exc:
            # A handler calling sys.exit or raising SystemExit would otherwise
            # walk through every guard above and take the whole session with it,
            # mid-interview. KeyboardInterrupt is deliberately not caught here:
            # Ctrl-C must still stop the server.
            self.log_traceback()
            if not is_notification:
                self.send_error(
                    message.get("id"),
                    INTERNAL_ERROR,
                    "handler attempted to exit the process: {0}".format(exc),
                )

    def _response_value(self, response: Dict[str, Any]) -> Any:
        if "error" in response:
            error = response.get("error")
            if isinstance(error, dict):
                raise RpcError(
                    int(error.get("code", INTERNAL_ERROR)),
                    str(error.get("message", "JSON-RPC error")),
                    error.get("data"),
                )
            raise RpcError(INTERNAL_ERROR, "Malformed JSON-RPC error response")
        return response.get("result")

    def _send(self, message: Dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        if "\n" in line or "\r" in line:
            raise ValueError("JSON-RPC messages must not contain embedded newlines")
        self.stdout.write(line + "\n")
        self.stdout.flush()

    def _configure_input(self, stream: Any) -> Any:
        if stream is sys.stdin:
            return self._reconfigure_text_stream(stream, "stdin")
        return stream

    def _configure_output(self, stream: Any) -> Any:
        if stream is sys.stdout:
            return self._reconfigure_text_stream(stream, "stdout")
        return stream

    def _reconfigure_text_stream(self, stream: Any, name: str) -> Any:
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
            return stream
        except AttributeError:
            buffer = getattr(stream, "buffer", None)
            if buffer is None:
                return stream
            return io.TextIOWrapper(buffer, encoding="utf-8", newline="\n")
