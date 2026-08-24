import unittest

from codex_adapter.profiles import (
    DEFAULT_PROFILE,
    UnknownProfileError,
    parse_profiles,
    profile_fingerprint,
    resolve_profile,
)


class ParseProfilesTests(unittest.TestCase):
    def test_absent_selection_keeps_every_capability(self):
        profiles = parse_profiles({"profiles": [{"name": "full"}]})

        profile = profiles["full"]
        self.assertIsNone(profile.skills)
        self.assertTrue(profile.allows_skill("anything"))
        self.assertTrue(profile.allows_tool("anything"))
        self.assertTrue(profile.allows_mcp_server("anything"))

    def test_listed_selection_restricts_capabilities(self):
        profiles = parse_profiles(
            {
                "profiles": [
                    {
                        "name": "marketing",
                        "skills": ["pptx"],
                        "tools": ["azure_blob"],
                        "mcp_servers": ["microsoft-learn"],
                    }
                ]
            }
        )

        profile = profiles["marketing"]
        self.assertTrue(profile.allows_skill("pptx"))
        self.assertFalse(profile.allows_skill("docx"))
        self.assertFalse(profile.allows_tool("m365_cli"))
        self.assertFalse(profile.allows_mcp_server("cloud-pricing"))

    def test_empty_selection_restricts_to_nothing(self):
        profiles = parse_profiles({"profiles": [{"name": "locked", "skills": []}]})

        self.assertEqual(profiles["locked"].skills, ())
        self.assertFalse(profiles["locked"].allows_skill("pptx"))

    def test_malformed_entries_are_skipped_not_fatal(self):
        profiles = parse_profiles(
            {
                "profiles": [
                    "nonsense",
                    {"display_name": "no name"},
                    {"name": "../../escape"},
                    {"name": "good"},
                ]
            }
        )

        self.assertEqual(list(profiles), ["good"])

    def test_unknown_reasoning_effort_is_dropped(self):
        profiles = parse_profiles(
            {"profiles": [{"name": "a", "reasoning_effort": "turbo"}]}
        )

        self.assertEqual(profiles["a"].reasoning_effort, "")

    def test_a_malformed_selection_rejects_the_profile_instead_of_widening_it(self):
        """A non-list selection must never be read as "every capability".

        The old parser turned anything that was not a list into ``None``, which
        the profile reads as unrestricted, so one bad edit silently promoted a
        restricted agent to the full catalogue.
        """
        profiles = parse_profiles(
            {
                "profiles": [
                    {"name": "broken-skills", "skills": "pptx"},
                    {"name": "broken-tools", "tools": 7},
                    {"name": "broken-mcp", "mcp_servers": {"a": 1}},
                    {"name": "good", "skills": ["pptx"]},
                ]
            }
        )

        self.assertEqual(list(profiles), ["good"])

    def test_an_explicit_null_selection_still_means_every_capability(self):
        profiles = parse_profiles({"profiles": [{"name": "a", "skills": None}]})

        self.assertIsNone(profiles["a"].skills)
        self.assertTrue(profiles["a"].allows_skill("anything"))


class ResolveProfileTests(unittest.TestCase):
    def test_no_request_falls_back_to_the_configured_default(self):
        profiles = parse_profiles(
            {"profiles": [{"name": "digibuddy"}, {"name": "marketing"}]}
        )

        self.assertEqual(resolve_profile(profiles, None).name, "digibuddy")
        self.assertEqual(resolve_profile(profiles, "  ").name, "digibuddy")
        self.assertEqual(resolve_profile(profiles, "marketing").name, "marketing")

    def test_an_unknown_named_profile_fails_closed(self):
        """Falling back would hand a deleted restricted agent the full catalogue."""
        profiles = parse_profiles(
            {"profiles": [{"name": "digibuddy"}, {"name": "marketing"}]}
        )

        with self.assertRaises(UnknownProfileError) as raised:
            resolve_profile(profiles, "missing")
        self.assertIn("missing", str(raised.exception))

    def test_an_unknown_profile_fails_closed_even_with_no_catalogue(self):
        with self.assertRaises(UnknownProfileError):
            resolve_profile({}, "marketing")

    def test_no_request_and_no_catalogue_uses_the_unrestricted_default(self):
        self.assertIs(resolve_profile({}, None), DEFAULT_PROFILE)


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_changes_when_the_rendered_config_would_change(self):
        profiles = parse_profiles(
            {
                "profiles": [
                    {"name": "a", "mcp_servers": ["one"]},
                    {"name": "b", "mcp_servers": ["one", "two"]},
                    {"name": "c", "mcp_servers": ["one"], "model": "other"},
                ]
            }
        )

        self.assertNotEqual(
            profile_fingerprint(profiles["a"]), profile_fingerprint(profiles["b"])
        )
        self.assertNotEqual(
            profile_fingerprint(profiles["a"]), profile_fingerprint(profiles["c"])
        )

    def test_fingerprint_covers_persona_skills_tools_and_empty_restrictions(self):
        profiles = parse_profiles(
            {
                "profiles": [
                    {"name": "a"},
                    {"name": "b", "persona": "Be brief."},
                    {"name": "c", "skills": []},
                    {"name": "d", "tools": ["fetch_url"]},
                ]
            }
        )

        fingerprints = {profile_fingerprint(profile) for profile in profiles.values()}
        self.assertEqual(len(fingerprints), 4)


if __name__ == "__main__":
    unittest.main()
