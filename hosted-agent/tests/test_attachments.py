import base64
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from codex_adapter.attachments import (
    attachment_prompt,
    collect_attachments,
    safe_filename,
    store_attachments,
)


def _message(*parts):
    return {"type": "message", "role": "user", "content": list(parts)}


class AttachmentTests(unittest.TestCase):
    def test_collects_base64_data_url(self):
        payload = base64.b64encode(b"%PDF-1.7").decode()
        items = [
            _message(
                {"type": "input_text", "text": "read this"},
                {
                    "type": "input_file",
                    "filename": "report.pdf",
                    "file_data": f"data:application/pdf;base64,{payload}",
                },
            )
        ]

        attachments = collect_attachments(items)

        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].filename, "report.pdf")
        self.assertEqual(attachments[0].data, b"%PDF-1.7")

    def test_skips_remote_url_without_bytes(self):
        items = [
            _message(
                {"type": "input_image", "image_url": "https://example.com/a.png"}
            )
        ]

        self.assertEqual(collect_attachments(items), [])

    def test_filename_cannot_escape_the_upload_folder(self):
        self.assertEqual(safe_filename("../../etc/passwd"), "passwd")
        self.assertEqual(safe_filename("../.."), "attachment")
        self.assertEqual(safe_filename(""), "attachment")

    def test_stores_without_overwriting(self):
        payload = base64.b64encode(b"one").decode()
        other = base64.b64encode(b"two").decode()
        items = [
            _message(
                {
                    "type": "input_file",
                    "filename": "a.txt",
                    "file_data": f"data:text/plain;base64,{payload}",
                },
                {
                    "type": "input_file",
                    "filename": "a.txt",
                    "file_data": f"data:text/plain;base64,{other}",
                },
            )
        ]

        with TemporaryDirectory() as directory:
            paths = store_attachments(collect_attachments(items), Path(directory))

            self.assertEqual([path.name for path in paths], ["a.txt", "a-1.txt"])
            self.assertEqual(paths[0].read_bytes(), b"one")
            self.assertEqual(paths[1].read_bytes(), b"two")

    def test_prompt_lists_stored_paths(self):
        prompt = attachment_prompt("summarise", [Path("/workspace/uploads/a.pdf")])

        self.assertIn("/workspace/uploads/a.pdf", prompt)
        self.assertTrue(prompt.startswith("summarise"))

    def test_prompt_unchanged_without_attachments(self):
        self.assertEqual(attachment_prompt("hello", []), "hello")


if __name__ == "__main__":
    unittest.main()
