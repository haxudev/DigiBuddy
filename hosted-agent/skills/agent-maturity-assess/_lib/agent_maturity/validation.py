#!/usr/bin/env python3
"""Validate an assessment.json against the documented schema.

Standard library only - no jsonschema dependency, so the skill runs on a clean
machine. This file is the machine-checkable definition of
`agent-maturity-assessment/2`; `references/scoring-rubric.md` is its prose
counterpart.

    python <skill-root>/scripts/validate.py <session-dir>/assessment.json
"""

from __future__ import annotations

import json
import sys

LEVELS = [100, 200, 300, 400, 500]
CONFIDENCE = {"evidenced", "asserted", "inferred"}


class Bad(Exception):
    pass


def need(cond, path, message):
    if not cond:
        raise Bad(f"{path}: {message}")


def check_type(value, types, path, label):
    need(isinstance(value, types), path, f"expected {label}, got {type(value).__name__}")


def check_i18n(node, path):
    check_type(node, dict, path, "object")
    need(set(node) == {"en", "zh"}, path, f"expected keys en+zh, got {sorted(node)}")
    for lang in ("en", "zh"):
        check_type(node[lang], str, f"{path}.{lang}", "string")
        need(node[lang].strip() != "", f"{path}.{lang}", "must not be empty")


def check_dimension(d, path):
    for key in ("id", "name", "source_heading", "rai_bearing", "claimed", "level",
                "capped", "cap_reason", "cap_codes", "confidence", "claimed_anchor",
                "current_anchor", "next_level", "probe2_answer"):
        need(key in d, path, f"missing key {key}")

    check_type(d["id"], str, f"{path}.id", "string")
    check_i18n(d["name"], f"{path}.name")
    check_type(d["rai_bearing"], bool, f"{path}.rai_bearing", "bool")
    need(d["claimed"] in LEVELS, f"{path}.claimed", f"must be one of {LEVELS}")
    need(d["level"] in LEVELS, f"{path}.level", f"must be one of {LEVELS}")
    need(d["level"] <= d["claimed"], f"{path}.level", "the evidence gate may only lower a level, never raise it")
    check_type(d["capped"], bool, f"{path}.capped", "bool")
    need(d["capped"] == (d["level"] != d["claimed"]), f"{path}.capped", "must agree with level vs claimed")
    if d["capped"]:
        need(isinstance(d["cap_reason"], dict), f"{path}.cap_reason",
             "a capped dimension must state why, so the customer sees the reasoning")
        check_i18n(d["cap_reason"], f"{path}.cap_reason")
    else:
        need(d["cap_reason"] is None, f"{path}.cap_reason", "must be null when the dimension is not capped")
    check_type(d["cap_codes"], list, f"{path}.cap_codes", "list")
    need(d["capped"] == bool(d["cap_codes"]), f"{path}.cap_codes",
         "must be non-empty exactly when the dimension is capped")
    need(set(d["cap_codes"]) <= {"no_artifact", "probe_failed", "pulse_ceiling"},
         f"{path}.cap_codes", "contains an unknown cap reason code")
    need(d["confidence"] in CONFIDENCE, f"{path}.confidence", f"must be one of {sorted(CONFIDENCE)}")
    if d["confidence"] == "evidenced":
        need(isinstance(d.get("evidence"), str) and d["evidence"].strip(), f"{path}.evidence",
             "confidence evidenced requires a named artifact")
    if d.get("qc_passed") is not None:
        need(isinstance(d.get("qc_answer"), str) and d["qc_answer"].strip(),
             f"{path}.qc_answer", "qc_passed requires the preserved customer answer")
    if d["probe2_answer"] is not None:
        need(isinstance(d["probe2_answer"], str) and d["probe2_answer"].strip(),
             f"{path}.probe2_answer", "must be null or non-empty text")
    check_i18n(d["claimed_anchor"], f"{path}.claimed_anchor")
    check_i18n(d["current_anchor"], f"{path}.current_anchor")
    if d["next_level"] is None:
        need(d.get("next_anchor") is None, f"{path}.next_anchor", "must be null when next_level is null")
    else:
        need(d["next_level"] in LEVELS and d["next_level"] > d["level"], f"{path}.next_level",
             "must be the next level above the scored level")
        check_i18n(d["next_anchor"], f"{path}.next_anchor")


def check_pillar(p, path):
    for key in ("id", "name", "source", "staged", "mean", "spread", "dimensions"):
        need(key in p, path, f"missing key {key}")
    check_i18n(p["name"], f"{path}.name")
    need(p["source"].startswith("https://learn.microsoft.com/"), f"{path}.source",
         "every pillar must trace to its Microsoft Learn page")
    check_type(p["dimensions"], list, f"{path}.dimensions", "list")
    need(len(p["dimensions"]) >= 3, f"{path}.dimensions", "expected at least 3 sub-dimensions")

    for i, d in enumerate(p["dimensions"]):
        check_dimension(d, f"{path}.dimensions[{i}]")

    levels = [d["level"] for d in p["dimensions"]]
    need(p["staged"] == min(levels), f"{path}.staged",
         f"staged must be min(sub-dimension levels) = {min(levels)}, got {p['staged']}")
    expected_mean = round(sum(levels) / len(levels), 1)
    need(abs(p["mean"] - expected_mean) < 0.05, f"{path}.mean",
         f"mean must be {expected_mean}, got {p['mean']}")
    need(p["spread"] == max(levels) - min(levels), f"{path}.spread", "spread must be max minus min")


def validate(doc):
    need(doc.get("schema") == "agent-maturity-assessment/2", "schema",
         "expected agent-maturity-assessment/2")
    for key in ("generated_at", "model", "methodology", "engagement", "pillars",
                "overall", "rai", "findings"):
        need(key in doc, "$", f"missing top-level key {key}")
    need(doc["methodology"].get("classification") == "project-authored diagnostic method",
         "methodology.classification",
         "must distinguish project scoring from the official Microsoft model")
    need(doc["methodology"].get("official_model_output") == "five-pillar maturity profile",
         "methodology.official_model_output",
         "the official-model output is the five-pillar profile")

    check_type(doc["pillars"], list, "pillars", "list")
    need(len(doc["pillars"]) == 5, "pillars", "the model has exactly five capability pillars")
    for i, p in enumerate(doc["pillars"]):
        check_pillar(p, f"pillars[{i}]")

    all_levels = [d["level"] for p in doc["pillars"] for d in p["dimensions"]]
    need(15 <= len(all_levels) <= 18, "pillars", f"expected 15-18 sub-dimensions, got {len(all_levels)}")
    tier = doc["engagement"].get("tier")
    need(tier in {"pulse", "standard", "deep"}, "engagement.tier",
         "must be pulse, standard or deep")
    for pillar in doc["pillars"]:
        for d in pillar["dimensions"]:
            expected_codes = []
            expected_level = d["claimed"]
            if d["claimed"] >= 300 and not (
                isinstance(d.get("evidence"), str) and d["evidence"].strip()
            ):
                expected_codes.append("no_artifact")
                expected_level = min(expected_level, 200)
            if d["claimed"] >= 400:
                if tier == "pulse":
                    expected_codes.append("pulse_ceiling")
                    expected_level = min(expected_level, 300)
                    need(d.get("qc_answer") is None and d.get("qc_passed") is None,
                         f"{d['id']}.qc", "Pulse must not carry Q-C state")
                elif d.get("qc_passed") is not True:
                    expected_codes.append("probe_failed")
                    expected_level = min(expected_level, 300)
            elif d.get("qc_answer") is not None or d.get("qc_passed") is not None:
                need(False, f"{d['id']}.qc", "Q-C is only valid for a 400/500 claim")
            need(d["cap_codes"] == expected_codes, f"{d['id']}.cap_codes",
                 f"expected {expected_codes}, got {d['cap_codes']}")
            need(d["level"] == expected_level, f"{d['id']}.level",
                 f"expected {expected_level} after applying the tier-aware evidence gate")

    need(doc["overall"]["staged"] == min(all_levels), "overall.staged",
         "overall staged must be the floor across every sub-dimension")
    need(abs(doc["overall"]["mean"] - round(sum(all_levels) / len(all_levels), 1)) < 0.05,
         "overall.mean", "overall mean must be the mean across every sub-dimension")
    need(doc["overall"].get("official") is False, "overall.official",
         "the organization-wide diagnostic floor must not be marked as an official Microsoft score")
    check_i18n(doc["overall"].get("label"), "overall.label")

    rai_ids = doc["rai"]["dimensions"]
    need(len(rai_ids) == 5, "rai.dimensions", "exactly one RAI-bearing dimension per pillar")
    flagged = [d["id"] for p in doc["pillars"] for d in p["dimensions"] if d["rai_bearing"]]
    need(sorted(rai_ids) == sorted(flagged), "rai.dimensions",
         f"rai.dimensions {sorted(rai_ids)} must match the flagged dimensions {sorted(flagged)}")
    rai_levels = [d["level"] for p in doc["pillars"] for d in p["dimensions"] if d["rai_bearing"]]
    need(doc["rai"]["staged"] == min(rai_levels), "rai.staged", "must be the floor across RAI-bearing dimensions")
    expected_rai_mean = round(sum(rai_levels) / len(rai_levels), 1)
    need(abs(doc["rai"]["mean"] - expected_rai_mean) < 0.05, "rai.mean",
         f"must be {expected_rai_mean}, got {doc['rai']['mean']}")

    profile = doc["rai"].get("profile")
    check_type(profile, list, "rai.profile", "list")
    need(len(profile) == 5, "rai.profile", "must contain one axis-aligned entry per pillar")
    expected_profile = []
    for pillar in doc["pillars"]:
        rai_dim = next(d for d in pillar["dimensions"] if d["rai_bearing"])
        capability = [d["level"] for d in pillar["dimensions"] if not d["rai_bearing"]]
        capability_mean = round(sum(capability) / len(capability), 1)
        expected_profile.append({
            "pillar": pillar["id"],
            "dimension": rai_dim["id"],
            "level": rai_dim["level"],
            "capability_mean": capability_mean,
            "lags_capability": rai_dim["level"] < capability_mean,
        })
    need(profile == expected_profile, "rai.profile",
         "must preserve the five pillar-specific RAI levels and lag comparisons")
    lagging = [item["pillar"] for item in expected_profile if item["lags_capability"]]
    need(doc["rai"].get("lagging_pillars") == lagging, "rai.lagging_pillars",
         f"must be {lagging}")
    need(doc["rai"].get("lags_capability") == bool(lagging), "rai.lags_capability",
         "must equal whether any pillar-specific RAI indicator lags its non-RAI capability mean")

    f = doc["findings"]
    for key in ("binding_constraint", "unevenness", "capped", "confidence_counts", "roadmap"):
        need(key in f, "findings", f"missing key {key}")
    need(f["binding_constraint"]["level"] == min(all_levels), "findings.binding_constraint.level",
         "the binding constraint must be the lowest scored level")
    need(sum(f["confidence_counts"].values()) == len(all_levels), "findings.confidence_counts",
         "confidence counts must account for every sub-dimension")
    for i, r in enumerate(f["roadmap"]):
        need(r["to"] > r["from"], f"findings.roadmap[{i}]", "a roadmap item must move upward")
        check_i18n(r["next_looks_like"], f"findings.roadmap[{i}].next_looks_like")
        check_i18n(r["next_action"], f"findings.roadmap[{i}].next_action")
        check_i18n(r["why_here"], f"findings.roadmap[{i}].why_here")
        need(r.get("action_type") in {"evidence-closure", "capability-step"},
             f"findings.roadmap[{i}].action_type", "must name the action type")


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        doc = json.load(fh)
    try:
        validate(doc)
    except Bad as exc:
        print(f"INVALID  {argv[1]}")
        print(f"  {exc}")
        return 1
    n = sum(len(p["dimensions"]) for p in doc["pillars"])
    print(f"VALID    {argv[1]}  ({len(doc['pillars'])} pillars, {n} sub-dimensions)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
