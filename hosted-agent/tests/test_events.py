import json
import unittest

from codex_adapter.events import completion_delta, tool_arguments, translate_notification


class EventTranslationTests(unittest.TestCase):
    def test_translates_assistant_delta(self):
        events = translate_notification(
            {
                "method": "item/agentMessage/delta",
                "params": {"delta": "hello"},
            }
        )

        self.assertEqual(events[0].type, "assistant.message.delta")
        self.assertEqual(events[0].data["delta"], "hello")

    def test_completed_message_recovers_an_absent_delta_stream(self):
        events = translate_notification(
            {
                "method": "item/completed",
                "params": {"item": {"type": "agentMessage", "text": "hello"}},
            }
        )

        self.assertEqual(events[0].type, "assistant.message.completed")
        self.assertEqual(completion_delta("", events[0].data["text"]), "hello")
        self.assertEqual(completion_delta("hel", events[0].data["text"]), "lo")
        self.assertEqual(completion_delta("different", "hello"), "")

    def test_translates_failed_turn(self):
        events = translate_notification(
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn-1", "status": "failed"}},
            }
        )

        self.assertEqual(events[0].type, "task.failed")

    def test_ignores_empty_delta(self):
        self.assertEqual(
            translate_notification(
                {"method": "item/agentMessage/delta", "params": {"delta": ""}}
            ),
            [],
        )

    def test_translates_reasoning_delta(self):
        events = translate_notification(
            {"method": "item/reasoning/delta", "params": {"delta": "weighing options"}}
        )

        self.assertEqual(events[0].type, "assistant.reasoning.delta")
        self.assertEqual(events[0].data["delta"], "weighing options")

    def test_completed_reasoning_is_reported_separately(self):
        events = translate_notification(
            {
                "method": "item/completed",
                "params": {"item": {"type": "reasoning", "text": "done thinking"}},
            }
        )

        self.assertEqual(events[0].type, "assistant.reasoning.completed")
        self.assertEqual(events[0].data["text"], "done thinking")

    def test_started_reasoning_emits_nothing(self):
        self.assertEqual(
            translate_notification(
                {
                    "method": "item/started",
                    "params": {"item": {"type": "reasoning", "text": "x"}},
                }
            ),
            [],
        )

    def test_tool_event_carries_a_one_line_summary(self):
        events = translate_notification(
            {
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "item-1",
                        "type": "commandExecution",
                        "command": ["pytest", "-q"],
                    }
                },
            }
        )

        self.assertEqual(events[0].type, "tool.started")
        self.assertEqual(events[0].data["summary"], "pytest -q")

    def test_file_change_summary_lists_paths(self):
        events = translate_notification(
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": "item-2",
                        "type": "fileChange",
                        "changes": [{"path": "src/a.py"}, {"path": "src/b.py"}],
                    }
                },
            }
        )

        self.assertEqual(events[0].type, "tool.completed")
        self.assertEqual(events[0].data["summary"], "src/a.py, src/b.py")

    def test_unknown_tool_summary_falls_back_to_a_label(self):
        events = translate_notification(
            {
                "method": "item/started",
                "params": {"item": {"id": "item-3", "type": "mcpToolCall"}},
            }
        )

        self.assertEqual(events[0].data["summary"], "Called an MCP tool")

    def test_final_tool_summary_becomes_one_valid_argument_document(self):
        self.assertEqual(
            tool_arguments({"summary": "src/a.py"}, "Edited files"),
            '{"summary": "src/a.py"}',
        )


if __name__ == "__main__":
    unittest.main()


class TurnFailureTests(unittest.TestCase):
    """A failed turn used to reach the user as a bare internal server error."""

    def test_a_failed_turn_carries_the_reason_codex_gave(self):
        events = translate_notification(
            {
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "id": "t1",
                        "status": "failed",
                        "error": {
                            "message": "context window exceeded",
                            "codexErrorInfo": {"type": "context_length"},
                        },
                    }
                },
            }
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].type, "task.failed")
        self.assertEqual(
            events[0].data["message"], "context window exceeded (context_length)"
        )

    def test_a_completed_turn_reports_no_failure(self):
        events = translate_notification(
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "t1", "status": "completed"}},
            }
        )

        self.assertEqual(events[0].type, "task.completed")
        self.assertNotIn("message", events[0].data)

    def test_a_failed_turn_without_detail_still_reports_the_failure(self):
        events = translate_notification(
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "t1", "status": "failed"}},
            }
        )

        self.assertEqual(events[0].type, "task.failed")
        self.assertEqual(events[0].data["message"], "")

    def test_an_error_notification_says_whether_codex_will_retry(self):
        events = translate_notification(
            {
                "method": "error",
                "params": {
                    "error": {"message": "rate limited", "codexErrorInfo": None},
                    "willRetry": True,
                    "threadId": "th",
                    "turnId": "t1",
                },
            }
        )

        self.assertEqual(events[0].type, "turn.error")
        self.assertEqual(events[0].data["message"], "rate limited")
        self.assertIs(events[0].data["will_retry"], True)

    def test_the_reason_is_not_repeated_when_the_message_already_names_it(self):
        events = translate_notification(
            {
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "failed",
                        "error": {
                            "message": "usage limit reached",
                            "codexErrorInfo": {"type": "Usage limit"},
                        },
                    }
                },
            }
        )

        self.assertEqual(events[0].data["message"], "usage limit reached")

    def test_additional_details_never_reach_the_event(self):
        # It can carry whatever a tool printed, including a credential.
        events = translate_notification(
            {
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "failed",
                        "error": {
                            "message": "tool failed",
                            "additionalDetails": "token=sk-secret",
                        },
                    }
                },
            }
        )

        self.assertNotIn("sk-secret", json.dumps(events[0].data))


class McpStartupTests(unittest.TestCase):
    """A server Codex could not start is dropped, and its tools just vanish."""

    def test_a_failed_server_is_reported_with_its_reason(self):
        events = translate_notification(
            {
                "method": "mcpServer/startupStatus/updated",
                "params": {
                    "name": "foundry-iq",
                    "status": "failed",
                    "error": "connection refused",
                    "failureReason": "startupTimeout",
                },
            }
        )

        self.assertEqual(events[0].type, "mcp.startup")
        self.assertEqual(events[0].data["server"], "foundry-iq")
        self.assertEqual(events[0].data["status"], "failed")
        self.assertEqual(events[0].data["message"], "connection refused")
        self.assertEqual(events[0].data["reason"], "startupTimeout")

    def test_a_ready_server_is_reported_too(self):
        events = translate_notification(
            {
                "method": "mcpServer/startupStatus/updated",
                "params": {"name": "microsoft-learn", "status": "ready"},
            }
        )

        self.assertEqual(events[0].data["status"], "ready")
        self.assertEqual(events[0].data["message"], "")
