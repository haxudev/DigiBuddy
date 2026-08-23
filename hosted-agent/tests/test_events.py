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
