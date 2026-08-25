"""Reading the frontmatter block at the top of a SKILL.md.

The twin of ``parseFrontmatter`` in ``webui/src/lib/skill-bundle.ts``. These
cases mirror ``webui/src/lib/skill-bundle.test.ts`` on purpose: a description
that parses in one plane and not the other puts a blank entry in the menu.
"""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from codex_adapter.frontmatter import (
    MAX_SKILL_MD_BYTES,
    parse_frontmatter,
    read_skill_frontmatter,
)


class ParsingFrontmatter(unittest.TestCase):
    def test_reads_name_and_description(self):
        front = parse_frontmatter(
            "---\nname: pptx\ndescription: Make slide decks.\n---\n\n# Body\n"
        )
        self.assertEqual(front.name, "pptx")
        self.assertEqual(front.description, "Make slide decks.")

    def test_strips_surrounding_quotes(self):
        front = parse_frontmatter('---\nname: pdf\ndescription: "Read PDFs."\n---\n')
        self.assertEqual(front.description, "Read PDFs.")

    def test_folds_a_wrapped_description_into_one_line(self):
        # Every real SKILL.md wraps its description, and a menu entry with a
        # newline in it renders as a broken row.
        front = parse_frontmatter(
            "---\n"
            "name: azure-pricing\n"
            "description: Fetches live Azure retail pricing.\n"
            "  Use when the user asks about cost.\n"
            "---\n"
        )
        self.assertEqual(
            front.description,
            "Fetches live Azure retail pricing. Use when the user asks about cost.",
        )

    def test_collapses_runs_of_whitespace(self):
        front = parse_frontmatter("---\ndescription: too    many     spaces\n---\n")
        self.assertEqual(front.description, "too many spaces")

    def test_ignores_keys_it_does_not_know(self):
        front = parse_frontmatter(
            "---\nname: docx\nlicense: MIT\nmetadata:\n  author: someone\n---\n"
        )
        self.assertEqual(front.name, "docx")
        self.assertEqual(front.description, "")

    def test_a_block_scalar_marker_is_not_the_description(self):
        front = parse_frontmatter("---\ndescription: |\n  The real text.\n---\n")
        self.assertEqual(front.description, "The real text.")

    def test_tolerates_a_byte_order_mark(self):
        front = parse_frontmatter("\ufeff---\nname: xlsx\n---\n")
        self.assertEqual(front.name, "xlsx")

    def test_tolerates_carriage_returns(self):
        front = parse_frontmatter("---\r\nname: pptx\r\ndescription: Decks.\r\n---\r\n")
        self.assertEqual(front.name, "pptx")
        self.assertEqual(front.description, "Decks.")

    def test_a_skill_without_frontmatter_is_still_a_skill(self):
        # Absent, never an error: refusing to catalogue it would hide a working
        # capability over a cosmetic detail.
        front = parse_frontmatter("# Just a heading\n\nSome prose.\n")
        self.assertEqual(front.name, "")
        self.assertEqual(front.description, "")

    def test_an_unterminated_block_yields_nothing(self):
        front = parse_frontmatter("---\nname: broken\ndescription: no closing marker\n")
        self.assertEqual(front.name, "")

    def test_body_text_is_not_mistaken_for_frontmatter(self):
        front = parse_frontmatter(
            "---\nname: real\n---\n\nname: not-the-name\ndescription: nor this\n"
        )
        self.assertEqual(front.name, "real")
        self.assertEqual(front.description, "")


class ReadingFromDisk(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_reads_a_file(self):
        path = self.root / "SKILL.md"
        path.write_text("---\nname: pptx\ndescription: Decks.\n---\n", encoding="utf-8")
        self.assertEqual(read_skill_frontmatter(path).description, "Decks.")

    def test_a_missing_file_is_absent_rather_than_fatal(self):
        self.assertEqual(read_skill_frontmatter(self.root / "gone.md").name, "")

    def test_an_oversized_file_is_not_scanned(self):
        # One huge file must not make building the catalogue expensive.
        path = self.root / "SKILL.md"
        path.write_text(
            "---\nname: huge\n---\n" + "x" * (MAX_SKILL_MD_BYTES + 1), encoding="utf-8"
        )
        self.assertEqual(read_skill_frontmatter(path).name, "")

    def test_undecodable_bytes_do_not_raise(self):
        path = self.root / "SKILL.md"
        path.write_bytes(b"---\nname: odd\ndescription: caf\xe9\n---\n")
        self.assertEqual(read_skill_frontmatter(path).name, "odd")


if __name__ == "__main__":
    unittest.main()
