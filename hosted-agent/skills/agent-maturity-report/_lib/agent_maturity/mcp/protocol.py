from __future__ import annotations

import sys
from typing import Any, Callable, Dict, Optional

from .. import __version__
from .jsonrpc import INVALID_REQUEST, METHOD_NOT_FOUND, Connection, RpcError

SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18")


class ElicitationUnsupported(Exception):
    pass


class Session:
    def __init__(self) -> None:
        self.connection: Optional[Connection] = None
        self.protocol_version: Optional[str] = None
        self.client_capabilities: Dict[str, Any] = {}
        self.initialized = False
        self.cancelled = []
        self.instructions = "Agentic AI adoption maturity assessment MCP server."
        self._handlers: Dict[str, Callable[[Any], Any]] = {}
        self._notification_handlers: Dict[str, Callable[[Any], Any]] = {}
        self._capabilities: Dict[str, Any] = {"logging": {}}
        self._builtin_handlers: Dict[str, Callable[[Any], Any]] = {
            "initialize": self._handle_initialize,
            "ping": self._handle_ping,
        }
        self._builtin_notifications: Dict[str, Callable[[Any], Any]] = {
            "notifications/initialized": self._handle_initialized,
            "notifications/cancelled": self._handle_cancelled,
        }

    @property
    def supports_elicitation(self) -> bool:
        return "elicitation" in self.client_capabilities

    @property
    def supports_elicitation_form(self) -> bool:
        elicitation = self.client_capabilities.get("elicitation")
        if not isinstance(elicitation, dict):
            return False
        return not elicitation or "form" in elicitation

    def attach(self, connection: Connection) -> None:
        self.connection = connection

    def register(self, method: str, handler: Callable[[Any], Any]) -> None:
        self._handlers[method] = handler
        if method.startswith("tools/"):
            self.declare_capability("tools", {"listChanged": False})
        elif method.startswith("resources/"):
            self.declare_capability("resources", {"subscribe": False, "listChanged": False})

    def register_notification(self, method: str, handler: Callable[[Any], Any]) -> None:
        self._notification_handlers[method] = handler

    def declare_capability(self, name: str, value: Any) -> None:
        current = self._capabilities.get(name)
        if isinstance(current, dict) and isinstance(value, dict):
            merged = dict(current)
            merged.update(value)
            self._capabilities[name] = merged
        else:
            self._capabilities[name] = value

    def dispatch(self, method: str, params: Any = None, is_notification: bool = False) -> Any:
        params = {} if params is None else params
        if is_notification:
            handler = self._builtin_notifications.get(method)
            if handler is None:
                handler = self._notification_handlers.get(method)
            if handler is None:
                return None
            return handler(params)

        handler = self._builtin_handlers.get(method)
        if handler is not None:
            return handler(params)

        if self.protocol_version is None and method != "ping":
            raise RpcError(INVALID_REQUEST, "Server has not been initialized")

        handler = self._handlers.get(method)
        if handler is None:
            raise RpcError(METHOD_NOT_FOUND, "Method not found")
        return handler(params)

    def elicit(
        self,
        message: str,
        requested_schema: Dict[str, Any],
        mode: str = "form",
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not self.supports_elicitation:
            raise ElicitationUnsupported("Client did not declare elicitation support")
        if self.connection is None:
            raise RuntimeError("Session has no JSON-RPC connection")
        params: Dict[str, Any] = {
            "message": message,
            "requestedSchema": requested_schema,
        }
        if self.protocol_version == "2025-11-25":
            params["mode"] = mode
        result = self.connection.request("elicitation/create", params, timeout=timeout)
        if not isinstance(result, dict):
            raise RpcError(INVALID_REQUEST, "elicitation/create returned a non-object result")
        return result

    def _handle_initialize(self, params: Any) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise RpcError(INVALID_REQUEST, "initialize params must be an object")
        requested = params.get("protocolVersion")
        if requested in SUPPORTED_PROTOCOL_VERSIONS:
            self.protocol_version = requested
        else:
            self.protocol_version = SUPPORTED_PROTOCOL_VERSIONS[0]
        capabilities = params.get("capabilities", {})
        self.client_capabilities = capabilities if isinstance(capabilities, dict) else {}
        return {
            "protocolVersion": self.protocol_version,
            "capabilities": self._server_capabilities(),
            "serverInfo": {
                "name": "agent-maturity",
                "title": "Agentic AI adoption maturity assessment",
                "version": __version__,
            },
            "instructions": self.instructions,
        }

    def _handle_ping(self, params: Any) -> Dict[str, Any]:
        return {}

    def _handle_initialized(self, params: Any) -> None:
        self.initialized = True

    def _handle_cancelled(self, params: Any) -> None:
        self.cancelled.append(params)

    def _server_capabilities(self) -> Dict[str, Any]:
        return dict(self._capabilities)


def run_stdio(session: Session, connection: Optional[Connection] = None) -> None:
    conn = connection if connection is not None else Connection()
    session.attach(conn)
    conn.serve_forever(session.dispatch)
