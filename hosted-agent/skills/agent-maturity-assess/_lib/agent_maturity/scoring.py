#!/usr/bin/env python3
"""Score an agent-maturity interview into assessment.json.

Standard library only. Reads an answers file plus the question bank and writes
the single artifact every renderer consumes.

    python <skill-root>/scripts/score.py --answers <session-dir>/answers.json --out <session-dir>/assessment.json

Scoring rules are the project's diagnostic method, not a Microsoft scoring
algorithm:

* The sub-dimension level comes from the chosen Q-A anchor and nothing else.
* Evidence gate: a claim of 300+ with no named artifact is capped at 200; a
  claim of 400+ additionally requires a passed Q-C or it is capped at 300.
* A conservative pillar floor is min(sub-dimension levels). The mean is
  computed too; the gap between them is the finding.
* Confidence is evidenced / asserted / inferred and never rounds upward.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

from .paths import bank_path

class ScoringError(Exception):
    """Bad input to the scorer.

    Never SystemExit: these functions run inside a long-lived MCP server, and
    SystemExit would walk straight through every `except Exception` guard in
    the call chain and take the process down mid-engagement.
    """


LEVELS = [100, 200, 300, 400, 500]
TIERS = {"pulse", "standard", "deep"}
ANSWER_SCHEMAS = {"agent-maturity-answers/1", "agent-maturity-answers/2"}


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def has_evidence(raw):
    value = raw.get("evidence")
    return isinstance(value, str) and value.strip() != ""


CAP_REASONS = {
    "no_artifact": {
        "en": "claimed 300 or above with no named artifact, capped at 200",
        "zh": "自述 300 及以上但说不出具名制品，封顶 200",
    },
    "probe_failed": {
        "en": "claimed 400 or above without passing the disconfirming probe, capped at 300",
        "zh": "自述 400 及以上但未通过证伪探针，封顶 300",
    },
    "pulse_ceiling": {
        "en": "Pulse is a screening tier and omits the disconfirming probe, capped at 300",
        "zh": "Pulse 是筛查级别且不提问证伪探针，封顶 300",
    },
}


def apply_evidence_gate(claimed, evidenced, qc_passed, tier):
    """Return level, capped, localized reason and stable reason codes."""
    level = claimed
    keys = []
    if claimed >= 300 and not evidenced:
        level = min(level, 200)
        keys.append("no_artifact")
    if claimed >= 400:
        if tier == "pulse":
            level = min(level, 300)
            keys.append("pulse_ceiling")
        elif qc_passed is not True:
            level = min(level, 300)
            keys.append("probe_failed")
    if not keys:
        return level, False, None, []
    reason = {
        lang: "; ".join(CAP_REASONS[k][lang] for k in keys)
        for lang in ("en", "zh")
    }
    return level, level != claimed, reason, keys


def mean(values):
    return round(sum(values) / len(values), 1) if values else 0.0


def score(bank, answers_doc):
    if bank.get("schema") != "agent-maturity-bank/2":
        raise ScoringError(
            f"question bank schema {bank.get('schema')!r} is not agent-maturity-bank/2"
        )
    schema = answers_doc.get("schema")
    if schema not in ANSWER_SCHEMAS:
        raise ScoringError(f"answers schema {schema!r} is not one of {sorted(ANSWER_SCHEMAS)}")
    tier = answers_doc.get("engagement", {}).get("tier", "standard")
    if tier not in TIERS:
        raise ScoringError(f"engagement.tier {tier!r} is not one of {sorted(TIERS)}")

    answers = answers_doc["answers"]
    pillars_out = []
    all_levels = []
    rai_profile = []
    dim_index = {}

    for pillar in bank["pillars"]:
        dims_out = []
        for dim in pillar["dimensions"]:
            did = dim["id"]
            if did not in answers:
                raise ScoringError(f"answers file is missing dimension {did}")
            raw = answers[did]
            claimed = raw.get("anchor")
            if claimed not in LEVELS:
                raise ScoringError(f"{did}: anchor {claimed!r} is not one of {LEVELS}")

            evidenced = has_evidence(raw)
            qc_answer = raw.get("qc")
            qc_passed = raw.get("qc_passed")
            if tier == "pulse" and (qc_answer is not None or qc_passed is not None):
                raise ScoringError(f"{did}: Pulse omits Q-C; use Standard or Deep to record a Q-C answer")
            if claimed < 400 and (qc_answer is not None or qc_passed is not None):
                raise ScoringError(f"{did}: Q-C is only valid for a 400/500 anchor")
            if qc_passed is not None and not (
                isinstance(qc_answer, str) and qc_answer.strip()
            ):
                raise ScoringError(f"{did}: qc_passed requires a non-empty qc answer")
            level, capped, cap_reason, cap_codes = apply_evidence_gate(
                claimed, evidenced, qc_passed, tier
            )

            if raw.get("inferred"):
                confidence = "inferred"
            elif evidenced:
                confidence = "evidenced"
            else:
                confidence = "asserted"

            anchors = {a["level"]: a["text"] for a in dim["qa"]["anchors"]}
            next_level = next((lv for lv in LEVELS if lv > level), None)

            record = {
                "id": did,
                "name": dim["name"],
                "source_heading": dim["source_heading"],
                "rai_bearing": bool(dim.get("rai_bearing")),
                "claimed": claimed,
                "level": level,
                "capped": capped,
                "cap_reason": cap_reason,
                "cap_codes": cap_codes,
                "confidence": confidence,
                "evidence": raw.get("evidence") or None,
                "quote": raw.get("quote") or None,
                "qc_answer": qc_answer or None,
                "qc_passed": qc_passed,
                "probe2_answer": raw.get("probe2") or None,
                "claimed_anchor": anchors[claimed],
                "current_anchor": anchors[level],
                "next_level": next_level,
                "next_anchor": anchors[next_level] if next_level else None,
            }
            dims_out.append(record)
            dim_index[did] = record
            all_levels.append(level)

        levels = [d["level"] for d in dims_out]
        pillar_out = {
            "id": pillar["id"],
            "name": pillar["name"],
            "source": pillar["source"],
            "staged": min(levels),
            "mean": mean(levels),
            "spread": max(levels) - min(levels),
            "dimensions": dims_out,
        }
        pillars_out.append(pillar_out)

        rai_dims = [d for d in dims_out if d["rai_bearing"]]
        if len(rai_dims) != 1:
            raise ScoringError(
                f"pillar {pillar['id']}: expected exactly one RAI-bearing dimension, got {len(rai_dims)}"
            )
        rai_dim = rai_dims[0]
        capability_levels = [d["level"] for d in dims_out if not d["rai_bearing"]]
        capability_mean = mean(capability_levels)
        rai_profile.append({
            "pillar": pillar["id"],
            "dimension": rai_dim["id"],
            "level": rai_dim["level"],
            "capability_mean": capability_mean,
            "lags_capability": rai_dim["level"] < capability_mean,
        })

    return pillars_out, all_levels, rai_profile, dim_index


def build_findings(pillars_out, dim_index):
    all_dims = [d for p in pillars_out for d in p["dimensions"]]

    lowest = min(d["level"] for d in all_dims)
    binding = [d["id"] for d in all_dims if d["level"] == lowest]

    unevenness = [
        {"pillar": p["id"], "staged": p["staged"], "mean": p["mean"], "spread": p["spread"],
         "held_back_by": [d["id"] for d in p["dimensions"] if d["level"] == p["staged"]]}
        for p in pillars_out if p["spread"] > 0
    ]
    unevenness.sort(key=lambda x: -x["spread"])

    capped = [
        {"id": d["id"], "claimed": d["claimed"], "level": d["level"], "reason": d["cap_reason"]}
        for d in all_dims if d["capped"]
    ]

    # Roadmap priority: the binding constraint first, then cheap wins where the
    # capability may already exist but the proof does not, then the rest lowest first.
    def rank(d):
        return (0 if d["id"] in binding else 1 if d["capped"] else 2, d["level"], d["id"])

    def why(d):
        if d["id"] in binding:
            return {
                "en": "binding constraint - the whole assessment is floored here",
                "zh": "制约瓶颈 —— 整份评估的底线就卡在这里",
            }
        if d["capped"]:
            return {
                "en": f"capability may already exist but is unproven: {d['cap_reason']['en']}",
                "zh": f"能力可能已经存在，但没有得到证明：{d['cap_reason']['zh']}",
            }
        return {"en": "next lowest scored dimension", "zh": "下一个得分最低的子维度"}

    def evidence_action(d):
        actions = {"en": [], "zh": []}
        if "no_artifact" in d["cap_codes"]:
            actions["en"].append(
                "Name and review an artifact that demonstrates the claimed practice"
            )
            actions["zh"].append("说出并核验一件能够证明所述实践的制品")
        if "probe_failed" in d["cap_codes"]:
            actions["en"].append(
                "Provide a concrete example that passes the disconfirming probe, or revise the claim"
            )
            actions["zh"].append("提供一个能够通过证伪探针的具体实例，否则修正原自述")
        if "pulse_ceiling" in d["cap_codes"]:
            actions["en"].append(
                "Run the Standard or Deep follow-up to test the 400/500 claim"
            )
            actions["zh"].append("运行 Standard 或 Deep 追问以验证 400/500 自述")
        return {lang: "; ".join(items) for lang, items in actions.items()}

    roadmap = []
    for d in sorted(all_dims, key=rank):
        if len(roadmap) == 6:
            break
        if d["capped"]:
            action_type = "evidence-closure"
            target_level = d["claimed"]
            target_anchor = d["claimed_anchor"]
            next_action = evidence_action(d)
        else:
            if d["next_level"] is None:
                continue
            action_type = "capability-step"
            target_level = d["next_level"]
            target_anchor = d["next_anchor"]
            next_action = d["next_anchor"]
        roadmap.append({
            "priority": len(roadmap) + 1,
            "dimension": d["id"],
            "name": d["name"],
            "action_type": action_type,
            "from": d["level"],
            "to": target_level,
            "today_looks_like": d["current_anchor"],
            "next_looks_like": target_anchor,
            "next_action": next_action,
            "why_here": why(d),
        })

    return {
        "binding_constraint": {"level": lowest, "dimensions": binding},
        "unevenness": unevenness,
        "capped": capped,
        "confidence_counts": {
            c: sum(1 for d in all_dims if d["confidence"] == c)
            for c in ("evidenced", "asserted", "inferred")
        },
        "roadmap": roadmap,
    }


def build_assessment(bank, answers_doc):
    """Assemble the single artifact every renderer consumes.

    Kept separate from `main` so callers that must not write to stdout - the
    MCP server in particular - can score without going through the CLI.
    """
    pillars_out, all_levels, rai_profile, dim_index = score(bank, answers_doc)
    rai_levels = [item["level"] for item in rai_profile]
    lagging_pillars = [
        item["pillar"] for item in rai_profile if item["lags_capability"]
    ]

    return {
        "schema": "agent-maturity-assessment/2",
        "generated_at": datetime.datetime.now().astimezone().replace(microsecond=0).isoformat(),
        "model": bank["model"],
        "methodology": {
            "classification": "project-authored diagnostic method",
            "official_model_output": "five-pillar maturity profile",
            "project_authored": [
                "15 sub-dimensions",
                "evidence caps",
                "conservative diagnostic floors and means",
                "roadmap prioritization",
                "Responsible AI overlay",
            ],
        },
        "engagement": answers_doc.get("engagement", {}),
        "pillars": pillars_out,
        "overall": {
            "staged": min(all_levels),
            "mean": mean(all_levels),
            "official": False,
            "label": {
                "en": "Project diagnostic floor",
                "zh": "项目诊断底线",
            },
        },
        "rai": {
            "staged": min(rai_levels),
            "mean": mean(rai_levels),
            "dimensions": [item["dimension"] for item in rai_profile],
            "profile": rai_profile,
            "lagging_pillars": lagging_pillars,
            "lags_capability": bool(lagging_pillars),
        },
        "findings": build_findings(pillars_out, dim_index),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--answers", required=True)
    ap.add_argument("--bank", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    bank = load_json(args.bank or bank_path())
    answers_doc = load_json(args.answers)

    try:
        assessment = build_assessment(bank, answers_doc)
    except ScoringError as exc:
        sys.stderr.write("error: {0}\n".format(exc))
        return 1
    pillars_out = assessment["pillars"]
    lagging_pillars = assessment["rai"]["lagging_pillars"]
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(assessment, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"wrote {args.out}")
    print(f"  project diagnostic floor {assessment['overall']['staged']}  mean {assessment['overall']['mean']}")
    print(
        f"  rai staged {assessment['rai']['staged']}  mean {assessment['rai']['mean']}  "
        f"lagging pillars={','.join(lagging_pillars) or 'none'}"
    )
    for p in pillars_out:
        print(f"  {p['id']}  staged {p['staged']:>3}  mean {p['mean']:>5}  spread {p['spread']}")
    if assessment["findings"]["capped"]:
        print("  evidence gate applied to: " + ", ".join(c["id"] for c in assessment["findings"]["capped"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
