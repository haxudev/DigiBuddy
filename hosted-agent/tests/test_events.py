import unittest

from codex_adapter.events import translate_notification


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


if __name__ == "__main__":
    unittest.main()
