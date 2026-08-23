"""The deterministic interview.

Question order, when the disconfirming probe fires, and how a tier batches the
evidence question used to live only in prose, so the model re-derived them on
every run and the same customer could get a different interview. They live here
now, as pure functions of `(bank, answers_doc)`.

Position is *derived from the recorded answers*, never from the stored cursor,
so a session resumes correctly even if the cursor was lost or hand-edited, and
an answers file produced somewhere else still resumes at the right question.
`progress.asked` supplements that for optional questions, which are legitimately
answered with nothing and so leave no content behind. The cursor is written for
humans.

The consulting judgement stays with the model: whether a Q-C answer passes its
written `pass_test`, what to quote verbatim, and when an answer was a guess.
Code cannot do those and does not pretend to.
"""

from __future__ import annotations

from . import bank as bank_mod
from .askspec import (
    MULTI,
    OPTIONS_AGENT,
    SINGLE,
    TEXT,
    AnswerError,
    AskSpec,
    Group,
    Option,
    letter_options,
)

FRAMING_PREFIX = "framing."
PARTICIPANT_ROLES = (
    "executive",
    "business-owner",
    "coe",
    "architecture",
    "security-risk",
    "operations",
    "change-enablement",
    "other",
)

# Answers that mean "I have nothing", which must not be written into `evidence`
# as if it were an artifact. Matched only on an exact, stripped, lowered token.
_EMPTY_TOKENS = frozenset(
    {
        "",
        "-",
        "--",
        "n/a",
        "na",
        "none",
        "nothing",
        "no",
        "nil",
        "unknown",
        "无",
        "没有",
        "不知道",
        "沒有",
    }
)

_STRINGS = {
    "framing.language": {
        "prompt": {
            "en": "Which language should we run this assessment in?",
            "zh": "本次评估使用哪种语言进行？",
        },
        "header": {"en": "语言 / Lang", "zh": "语言 / Lang"},
        "options": {"en": "English", "zh": "中文"},
    },
    "framing.organization": {
        "prompt": {
            "en": "What is the name of the organization being assessed?",
            "zh": "本次接受评估的组织名称是什么？",
        },
        "header": {"en": "Organization", "zh": "组织"},
    },
    "framing.sector": {
        "prompt": {
            "en": "Which sector or industry does it operate in?",
            "zh": "该组织属于哪个行业或领域？",
        },
        "header": {"en": "Sector", "zh": "行业"},
    },
    "framing.roles": {
        "prompt": {
            "en": "Who is in the room? Select every role taking part.",
            "zh": "今天有哪些角色参与？请选出所有在场的角色。",
        },
        "help": {
            "en": "Different answers come from a CIO and from the person who runs the agents. Record both.",
            "zh": "CIO 与真正在跑 agent 的人给出的答案会不同，两者都要记录。",
        },
        "header": {"en": "Who is here", "zh": "参与角色"},
        "labels": {
            "executive": {"en": "Executive / sponsor", "zh": "高管 / 发起人"},
            "business-owner": {"en": "Business process owner", "zh": "业务流程负责人"},
            "coe": {"en": "AI CoE / centre of excellence", "zh": "AI 卓越中心（CoE）"},
            "architecture": {"en": "Architecture / platform", "zh": "架构 / 平台"},
            "security-risk": {"en": "Security, risk or compliance", "zh": "安全、风险或合规"},
            "operations": {"en": "Operations / support", "zh": "运维 / 支持"},
            "change-enablement": {"en": "Change and enablement", "zh": "变革与赋能"},
            "other": {"en": "Other (I will name them)", "zh": "其他（稍后说明）"},
        },
    },
    "framing.roles_other": {
        "prompt": {
            "en": "Which other roles are taking part?",
            "zh": "还有哪些其他角色参与？",
        },
        "header": {"en": "Other roles", "zh": "其他角色"},
    },
    "framing.focus": {
        "prompt": {
            "en": "Which pillars need extra attention in the debrief? This changes emphasis only - all five are still assessed.",
            "zh": "复盘时希望重点关注哪些支柱？这只影响讲解侧重，五个支柱仍会全部评估。",
        },
        "header": {"en": "Focus", "zh": "重点"},
    },
    "framing.tier": {
        "prompt": {
            "en": "How deep should this go? Say the depth out loud and get agreement before starting.",
            "zh": "本次评估要做到多深？开始前请明确说出深度并取得一致。",
        },
        "header": {"en": "Depth", "zh": "深度"},
        "help": {
            "en": "A customer who expected 20 minutes will start guessing at question 25, and guesses score.",
            "zh": "以为只要 20 分钟的客户，问到第 25 题就会开始猜，而猜测同样会计入评分。",
        },
        "labels": {
            "pulse": {"en": "Pulse - first executive conversation", "zh": "Pulse - 首次高管沟通"},
            "standard": {"en": "Standard - the normal engagement", "zh": "Standard - 常规评估"},
            "deep": {"en": "Deep - pre-investment, or a disputed result", "zh": "Deep - 投资决策前，或结果有争议"},
        },
        "ceiling_note": {
            "en": "screening tier, results capped at 300",
            "zh": "筛查层级，结果上限为 300",
        },
    },
    "qb_help": {
        "en": "Record the artifact they name, verbatim. If they cannot name anything, leave it empty - do not argue and do not write 'none'.",
        "zh": "逐字记录他们说出的证据物。如果说不出来，留空即可——不要争辩，也不要写「无」。",
    },
    "qc_help": {
        "en": "This fired because the anchor claimed 400 or 500. Judge the answer against the written pass_test, not against how confident the person sounded.",
        "zh": "该问题因为选中了 400 或 500 的锚点而触发。请依据写明的 pass_test 判定，而不是依据对方的自信程度。",
    },
    "probe2_help": {
        "en": "Deep only. This triangulates; it does not change the numeric level.",
        "zh": "仅 Deep 层级。用于交叉印证，不改变分数。",
    },
    "qa_help": {
        "en": "Read the options as written and let them pick the one that sounds like their Tuesday. Never read out a level number.",
        "zh": "照原文念出选项，让对方挑出最像他们日常的那一条。绝不要念出级别数字。",
    },
}

# Everything a selection card puts in front of the customer. It lives here
# rather than in `askspec.py` because a literal written into that module would
# be an English string stranded inside a translated card.
_CARD = {
    # -- the anchored choice, when a host caps a card below five options ----
    "qa_escape_label": {
        "en": "None of these - we are further along than all of them",
        "zh": "以上都不是，我们比这更进一步",
    },
    "qa_escape_description": {
        "en": "Choose this and the remaining descriptions follow.",
        "zh": "选这一项，接着会给出剩下的描述。",
    },
    # -- the evidence probe -------------------------------------------------
    "qb_unnamed": {
        "en": "There is one, but I cannot name it right now",
        "zh": "有这么个东西，但我现在说不出名字",
    },
    "qb_absent": {
        "en": "There is no such artifact",
        "zh": "没有这样的东西",
    },
    "qb_free_text": {
        "en": "If there is one, type its name here - that is what gets recorded.",
        "zh": "如果有，请在这里写出它的名字——真正被记录下来的是这个。",
    },
    # -- the disconfirming probe -------------------------------------------
    "qc_caption": {
        "en": (
            "Say the actual thing if you can; that is the answer that counts. "
            "The options are the usual ways of not being able to."
        ),
        "zh": "能说出那件事就直接说，这才是真正算数的回答。选项是常见的「说不上来」的几种情况。",
    },
    "qc_free_text": {
        "en": "Describe the specific instance here.",
        "zh": "在这里描述那件具体的事。",
    },
    "probe2_caption": {
        "en": "Answer in your own words if you can; the options are only a starting point.",
        "zh": "能用自己的话说就直接说；选项只是个起点。",
    },
    "probe2_free_text": {
        "en": "Answer in your own words here.",
        "zh": "在这里用自己的话回答。",
    },
    # -- framing ------------------------------------------------------------
    "org_placeholder_label": {
        "en": "Use a placeholder for now",
        "zh": "暂时用占位名",
    },
    "org_placeholder_value": {
        "en": "(organization not yet named)",
        "zh": "（组织名待定）",
    },
    "org_free_text": {
        "en": "Or type the organization's name.",
        "zh": "或者直接输入组织名称。",
    },
    "org_free_option": {"en": "Let me type it", "zh": "我来输入"},
    "sector_other_label": {
        "en": "Cross-sector, or not specific to one",
        "zh": "跨行业，或不特定于某一行业",
    },
    "sector_free_text": {
        "en": "Or type the sector.",
        "zh": "或者直接输入所属行业。",
    },
    "roles_free_text": {
        "en": "Or type any other roles taking part.",
        "zh": "或者直接输入其他参与的角色。",
    },
    "batched_option": {
        "en": "{0} - I cannot name an artifact",
        "zh": "{0} — 说不出制品",
    },
    "batched_free_text": {
        "en": "For the ones you can name, type them as A1: name; A2: name.",
        "zh": "能说出名字的，请按 A1: 名称；A2: 名称 的格式填写。",
    },
    "qc_option_judgement": {
        "en": "Answered by picking an offered option rather than describing a specific instance, so the probe did not pass.",
        "zh": "以选择既有选项作答，未描述具体事例，因此该反证探针未通过。",
    },
}

# Read by the agent, never by the customer, so it is a plain string like
# `source_heading` rather than a localized node.
QC_OPTION_RULE = (
    "Generate 2-3 options for this card, in the engagement language. Every one "
    "must be a way of NOT answering - vague, generic, or 'I would have to check' "
    "- worded in this customer's own vocabulary, seeded by meta.fail_exemplar. "
    "None may contain the specificity meta.judge_rule tests for, and you may "
    "only re-present something the customer has already said in this session. "
    "Never show meta.judge_rule or meta.facilitator_note to the customer. Every "
    "option is recorded as a failed probe whatever it says, so a specific answer "
    "can only arrive through the free-text slot: record it with "
    "answer_source='option' or 'free_text' accordingly."
)

PROBE2_OPTION_RULE = (
    "Generate 2-3 options for this card, in the engagement language, from what "
    "the customer has already said. This probe triangulates and is never scored, "
    "so an option here changes nothing but the conversation."
)

FRAMING_OPTION_RULES = {
    "organization": (
        "Generate up to three organization-name options only from names already "
        "stated in this conversation. Never invent a customer name. Keep the "
        "supplied placeholder option last."
    ),
    "sector": (
        "Generate two or three sector options supported by context already "
        "stated in this conversation. Keep the supplied cross-sector option last."
    ),
    "roles_other": (
        "Generate two or three role options only from roles already mentioned "
        "in this conversation. Never invent a participant."
    ),
}


class InterviewError(Exception):
    pass


# ---------------------------------------------------------------- helpers


def _s(key, field, lang, default=""):
    node = _STRINGS.get(key, {}).get(field)
    return bank_mod.t(node, lang, default=default)


def _c(key, lang, default=""):
    return bank_mod.t(_CARD.get(key), lang, default=default)


def language_of(doc: dict) -> str:
    return bank_mod.normalize_language(doc.get("engagement", {}).get("language"))


def _asked(doc: dict):
    return doc.setdefault("progress", {}).setdefault("asked", [])


def asked_ids(doc: dict):
    """Ask ids already put to the customer and resolved, in order."""
    return list(_asked(doc))


def _mark_asked(doc: dict, ask_id: str):
    asked = _asked(doc)
    if ask_id not in asked:
        asked.append(ask_id)


def _unmark_asked(doc: dict, ask_id: str):
    asked = _asked(doc)
    while ask_id in asked:
        asked.remove(ask_id)


def is_empty_answer(text) -> bool:
    return not isinstance(text, str) or text.strip().lower() in _EMPTY_TOKENS


def split_ask_id(ask_id: str):
    if "." not in ask_id:
        raise InterviewError("malformed ask id {0!r}".format(ask_id))
    head, _, field = ask_id.partition(".")
    return head, field


# ---------------------------------------------------------------- sequence


def sequence(bank: dict, doc: dict):
    """Yield ask ids in interview order, stopping where the next step is not
    yet knowable (because it depends on an answer that has not been given)."""
    engagement = doc.get("engagement", {})
    answers = doc.get("answers", {})

    yield FRAMING_PREFIX + "language"
    yield FRAMING_PREFIX + "organization"
    yield FRAMING_PREFIX + "sector"
    yield FRAMING_PREFIX + "roles"
    if "other" in (engagement.get("participant_roles") or []):
        yield FRAMING_PREFIX + "roles_other"
    yield FRAMING_PREFIX + "focus"
    yield FRAMING_PREFIX + "tier"

    tier = engagement.get("tier")
    if not tier:
        return
    config = bank_mod.tier_config(bank, tier)
    batched = config.get("qb") == "batched-per-pillar"

    for pillar in bank_mod.pillars(bank):
        for dimension in pillar.get("dimensions", []):
            dim_id = dimension["id"]
            yield "{0}.qa".format(dim_id)
            if not batched:
                yield "{0}.qb".format(dim_id)
            anchor = (answers.get(dim_id) or {}).get("anchor")
            if anchor is None:
                return
            if config.get("qc"):
                fires_at = dimension.get("qc", {}).get("fires_at") or []
                if anchor in fires_at:
                    yield "{0}.qc".format(dim_id)
            if config.get("probe2"):
                yield "{0}.probe2".format(dim_id)
        if batched:
            yield "{0}.qb_batched".format(pillar["id"])


def _content_resolved(bank: dict, doc: dict, ask_id: str) -> bool:
    """Has this ask already been answered, judged from the recorded content?

    An answers file produced elsewhere - a fixture, a v1 document, a hand-edited
    one - has no `progress.asked`, so resolution has to be readable from the
    answers themselves or such a file would resume at question one.
    """
    engagement = doc.get("engagement") or {}
    answers = doc.get("answers") or {}
    head, field = split_ask_id(ask_id)

    if head == "framing":
        key = {
            "language": "language",
            "organization": "organization",
            "sector": "sector",
            "roles": "participant_roles",
            "roles_other": "participant_roles_other",
            "focus": "focus_pillars",
            "tier": "tier",
        }.get(field)
        # `focus_pillars` may legitimately be an empty list, so presence of the
        # key is the test, not truthiness.
        return key in engagement

    if field == "qa":
        return (answers.get(head) or {}).get("anchor") is not None
    if field == "qb":
        return bool((answers.get(head) or {}).get("evidence"))
    if field in ("qc", "probe2"):
        return bool((answers.get(head) or {}).get(field))
    if field == "qb_batched":
        pillar = bank_mod.find_pillar(bank, head)
        return any(
            (answers.get(d["id"]) or {}).get("evidence")
            for d in pillar.get("dimensions", [])
        )
    return False


def is_resolved(bank: dict, doc: dict, ask_id: str) -> bool:
    return ask_id in _asked(doc) or _content_resolved(bank, doc, ask_id)


def next_ask_id(bank: dict, doc: dict):
    for ask_id in sequence(bank, doc):
        if not is_resolved(bank, doc, ask_id):
            return ask_id
    return None


def next_ask(bank: dict, doc: dict):
    ask_id = next_ask_id(bank, doc)
    if ask_id is None:
        return None
    return build_ask(bank, doc, ask_id)


# ---------------------------------------------------------------- builders


def build_ask(bank: dict, doc: dict, ask_id: str) -> AskSpec:
    head, field = split_ask_id(ask_id)
    if head == "framing":
        return _build_framing(bank, doc, ask_id, field)
    if field == "qb_batched":
        return _build_qb_batched(bank, doc, head)
    return _build_dimension_ask(bank, doc, head, field)


def _progress_meta(bank: dict, doc: dict) -> dict:
    engagement = doc.get("engagement", {})
    tier = engagement.get("tier")
    meta = {"answered": len(_asked(doc))}
    if tier:
        config = bank_mod.tier_config(bank, tier)
        meta["tier"] = tier
        meta["expected_questions"] = config.get("expected_questions")
        meta["duration"] = config.get("duration")
    scored = doc.get("answers") or {}
    meta["dimensions_scored"] = len(
        [d for d in scored.values() if (d or {}).get("anchor") is not None]
    )
    meta["dimensions_total"] = len(bank_mod.dimension_ids(bank))
    return meta


def _build_framing(bank: dict, doc: dict, ask_id: str, field: str) -> AskSpec:
    lang = language_of(doc)
    key = FRAMING_PREFIX + field
    common = {
        "meta": {"phase": "framing", "progress": _progress_meta(bank, doc)},
        "header": _s(key, "header", lang, default=field),
    }

    if field == "language":
        node = _STRINGS[key]
        prompt = "{0} / {1}".format(
            bank_mod.t(node["prompt"], "en"), bank_mod.t(node["prompt"], "zh")
        )
        options = [
            Option(id=code, label=bank_mod.t(node["options"], code))
            for code in bank_mod.LANGUAGES
        ]
        return AskSpec(id=ask_id, kind=SINGLE, prompt=prompt, options=options, **common)

    if field == "organization":
        # The agent supplies the candidates, because the only names worth
        # offering are ones already spoken in this conversation. The fixed
        # option is the honest way out when none were.
        return AskSpec(
            id=ask_id,
            kind=SINGLE,
            prompt=_s(key, "prompt", lang),
            options=[
                Option(
                    id="placeholder",
                    label=_c("org_placeholder_label", lang),
                    description=_c("org_placeholder_value", lang),
                )
            ],
            option_source=OPTIONS_AGENT,
            allow_free_text=True,
            free_text_label=_c("org_free_text", lang),
            free_text_option_label=_c("org_free_option", lang),
            meta=dict(common["meta"], option_rule=FRAMING_OPTION_RULES[field]),
            header=common["header"],
        )

    if field == "sector":
        return AskSpec(
            id=ask_id,
            kind=SINGLE,
            prompt=_s(key, "prompt", lang),
            options=[
                Option(id="cross-sector", label=_c("sector_other_label", lang))
            ],
            option_source=OPTIONS_AGENT,
            allow_free_text=True,
            free_text_label=_c("sector_free_text", lang),
            free_text_option_label=_c("org_free_option", lang),
            meta=dict(common["meta"], option_rule=FRAMING_OPTION_RULES[field]),
            header=common["header"],
        )

    if field == "roles_other":
        return AskSpec(
            id=ask_id,
            kind=TEXT,
            prompt=_s(key, "prompt", lang),
            required=False,
            allow_free_text=True,
            free_text_label=_c("roles_free_text", lang),
            option_source=OPTIONS_AGENT,
            meta=dict(common["meta"], option_rule=FRAMING_OPTION_RULES[field]),
            header=common["header"],
        )

    if field == "roles":
        labels = _STRINGS[key]["labels"]
        options = [
            Option(id=role, label=bank_mod.t(labels[role], lang))
            for role in PARTICIPANT_ROLES
        ]
        return AskSpec(
            id=ask_id,
            kind=MULTI,
            prompt=_s(key, "prompt", lang),
            facilitator_note=_s(key, "help", lang),
            options=options,
            min_items=1,
            # A typed role is the same answer `roles_other` would collect, so
            # collecting it here spares the customer a second question.
            allow_free_text=True,
            free_text_label=_c("roles_free_text", lang),
            **common
        )

    if field == "focus":
        options = [
            Option(id=p["id"], label="{0} - {1}".format(p["id"], bank_mod.t(p["name"], lang)))
            for p in bank_mod.pillars(bank)
        ]
        return AskSpec(
            id=ask_id,
            kind=MULTI,
            prompt=_s(key, "prompt", lang),
            options=options,
            min_items=0,
            required=False,
            **common
        )

    if field == "tier":
        labels = _STRINGS[key]["labels"]
        options = []
        for tier_id in bank_mod.tier_ids(bank):
            config = bank_mod.tier_config(bank, tier_id)
            label = bank_mod.t(labels.get(tier_id), lang, default=tier_id)
            detail = "{0}, {1}".format(
                config.get("expected_questions", "?"), config.get("duration", "?")
            )
            if config.get("score_ceiling"):
                detail += "; " + _s(key, "ceiling_note", lang)
            options.append(Option(id=tier_id, label=label, description=detail))
        return AskSpec(
            id=ask_id,
            kind=SINGLE,
            prompt=_s(key, "prompt", lang),
            facilitator_note=_s(key, "help", lang),
            options=options,
            **common
        )

    raise InterviewError("unknown framing ask {0!r}".format(ask_id))


def _dimension_meta(bank: dict, doc: dict, pillar: dict, dimension: dict) -> dict:
    lang = language_of(doc)
    return {
        "phase": "interview",
        "pillar": pillar["id"],
        "pillar_name": bank_mod.t(pillar.get("name"), lang),
        "dimension": dimension["id"],
        "dimension_name": bank_mod.t(dimension.get("name"), lang),
        "rai_bearing": bool(dimension.get("rai_bearing")),
        "source_heading": bank_mod.t(dimension.get("source_heading"), lang),
        "progress": _progress_meta(bank, doc),
    }


def _build_dimension_ask(bank: dict, doc: dict, dim_id: str, field: str) -> AskSpec:
    pillar, dimension = bank_mod.find_dimension(bank, dim_id)
    lang = language_of(doc)
    meta = _dimension_meta(bank, doc, pillar, dimension)
    header = bank_mod.dimension_header(dimension, lang)

    if field == "qa":
        anchors = bank_mod.anchors(dimension)
        # The level each anchor maps to is deliberately absent from the AskSpec:
        # an ask that does not carry the numbers cannot leak them to the customer.
        # The band split is presentational too - a host that caps a card below
        # five options folds `high` behind one option and asks a second card,
        # and both routes resolve to the same option id.
        labels, descriptions = [], []
        for anchor in anchors:
            label, description = bank_mod.anchor_label(anchor, lang)
            labels.append(label)
            descriptions.append(description)
        bands = ["low"] * 3 + ["high"] * (len(anchors) - 3)
        options = letter_options(labels, descriptions=descriptions, groups=bands)
        groups = [
            Group(id="low", option_ids=[o.id for o in options if o.group == "low"]),
            Group(
                id="high",
                option_ids=[o.id for o in options if o.group == "high"],
                label=_c("qa_escape_label", lang),
                description=_c("qa_escape_description", lang),
            ),
        ]
        return AskSpec(
            id="{0}.qa".format(dim_id),
            kind=SINGLE,
            prompt=bank_mod.t(dimension.get("qa", {}).get("prompt"), lang),
            facilitator_note=bank_mod.t(_STRINGS["qa_help"], lang),
            options=options,
            groups=groups,
            header=header,
            # The five anchors are exhaustive by construction, so a typed answer
            # would be unscoreable. Hosts whose card offers free text by default
            # must switch it off here.
            allow_free_text=False,
            meta=dict(meta, question_type="anchored-behavioral-choice"),
        )

    if field == "qb":
        # Clicking is how you say no; naming the artifact is how you say yes.
        # The asymmetry is deliberate: the evidence gate is a mechanical
        # non-empty test with no judge behind it, so an option that could open
        # it would open it on nothing.
        return AskSpec(
            id="{0}.qb".format(dim_id),
            kind=SINGLE,
            prompt=bank_mod.t(dimension.get("qb", {}).get("prompt"), lang),
            facilitator_note=bank_mod.t(_STRINGS["qb_help"], lang),
            options=[
                Option(id="unnamed", label=_c("qb_unnamed", lang)),
                Option(id="absent", label=_c("qb_absent", lang)),
            ],
            header=header,
            allow_free_text=True,
            free_text_label=_c("qb_free_text", lang),
            required=False,
            meta=dict(meta, question_type="evidence-probe"),
        )

    if field == "qc":
        qc = dimension.get("qc", {})
        prompt = "{0}\n\n{1}".format(
            bank_mod.t(qc.get("prompt"), lang), _c("qc_caption", lang)
        )
        return AskSpec(
            id="{0}.qc".format(dim_id),
            kind=TEXT,
            prompt=prompt,
            facilitator_note=bank_mod.t(_STRINGS["qc_help"], lang),
            header=header,
            option_source=OPTIONS_AGENT,
            allow_free_text=True,
            free_text_label=_c("qc_free_text", lang),
            required=False,
            meta=dict(
                meta,
                question_type="disconfirming-probe",
                judge_rule=bank_mod.t(qc.get("pass_test"), lang),
                fail_exemplar=bank_mod.fail_exemplar(dimension, lang),
                option_policy="picked-option-is-fail",
                option_rule=QC_OPTION_RULE,
                fires_at=qc.get("fires_at"),
            ),
        )

    if field == "probe2":
        prompt = "{0}\n\n{1}".format(
            bank_mod.t(dimension.get("probe2", {}).get("prompt"), lang),
            _c("probe2_caption", lang),
        )
        return AskSpec(
            id="{0}.probe2".format(dim_id),
            kind=TEXT,
            prompt=prompt,
            facilitator_note=bank_mod.t(_STRINGS["probe2_help"], lang),
            header=header,
            option_source=OPTIONS_AGENT,
            allow_free_text=True,
            free_text_label=_c("probe2_free_text", lang),
            required=False,
            meta=dict(
                meta,
                question_type="triangulating-probe",
                scored=False,
                option_rule=PROBE2_OPTION_RULE,
            ),
        )

    raise InterviewError("unknown ask field {0!r} for {1}".format(field, dim_id))


def _build_qb_batched(bank: dict, doc: dict, pillar_id: str) -> AskSpec:
    pillar = bank_mod.find_pillar(bank, pillar_id)
    lang = language_of(doc)
    batched = pillar.get("qb_batched", {})
    dimensions = pillar.get("dimensions", [])
    dim_ids = [d["id"] for d in dimensions]
    template = _c("batched_option", lang)
    options = [
        Option(
            id=d["id"],
            label=template.format(
                "{0} {1}".format(d["id"], bank_mod.t(d.get("name"), lang))
            ),
        )
        for d in dimensions
    ]
    return AskSpec(
        id="{0}.qb_batched".format(pillar_id),
        kind=MULTI,
        prompt=bank_mod.t(batched.get("prompt"), lang),
        facilitator_note=bank_mod.t(_STRINGS["qb_help"], lang),
        options=options,
        header="{0} {1}".format(pillar_id, bank_mod.t(pillar.get("name"), lang)),
        allow_free_text=True,
        free_text_label=_c("batched_free_text", lang),
        placeholder="; ".join("{0}: ".format(d) for d in dim_ids),
        min_items=0,
        required=False,
        meta={
            "phase": "interview",
            "pillar": pillar_id,
            "pillar_name": bank_mod.t(pillar.get("name"), lang),
            "dimensions": dim_ids,
            "question_type": "batched-evidence-probe",
            "response_format": batched.get("response_format"),
            "progress": _progress_meta(bank, doc),
        },
    )


# ---------------------------------------------------------------- recording


def parse_evidence_map(text: str, dim_ids):
    """Parse `A1: strategy.pdf; A2: none; A3: catalogue` into {dim: artifact}.

    Only dimensions named in `dim_ids` are accepted, so one pillar's artifact
    can never be copied into a dimension it does not support.
    """
    found = {}
    if not isinstance(text, str):
        return found
    allowed = set(dim_ids)
    chunks = []
    for line in text.replace(";", "\n").splitlines():
        chunks.append(line)
    for chunk in chunks:
        if ":" not in chunk and "：" not in chunk:
            continue
        separator = ":" if ":" in chunk else "："
        key, _, value = chunk.partition(separator)
        key = key.strip().upper()
        if key not in allowed:
            continue
        value = value.strip()
        if is_empty_answer(value):
            continue
        found[key] = value
    return found


def fires_probe(dimension: dict, anchor) -> bool:
    return anchor in (dimension.get("qc", {}).get("fires_at") or [])


def _clear_stale_probe(dimension: dict, entry: dict):
    """A revised anchor invalidates the probe that the old anchor fired.

    Leaving `qc` behind after a downward revision produces an answers file the
    scorer rejects outright, which is a worse outcome than the revision itself.
    """
    if fires_probe(dimension, entry.get("anchor")):
        return
    for key in ("qc", "qc_passed", "qc_judgement"):
        entry.pop(key, None)


ANSWER_SOURCES = ("option", "free_text")


def split_multi_answer(ask: AskSpec, values):
    """Separate an answer into the options that were ticked and the words typed."""
    known = set(ask.option_ids)
    picked = [v for v in values if v in known]
    typed = [v for v in values if v not in known]
    return picked, typed


def _answer_source(ask: AskSpec, normalized, declared):
    """Was this answer clicked or typed?

    Derived wherever the AskSpec owns the options, because deriving it cannot be
    got wrong. Only an agent-generated card has to be taken at its word, and
    that is exactly the card where the distinction decides a probe.
    """
    if declared is not None and declared not in ANSWER_SOURCES:
        raise InterviewError(
            "answer_source must be one of {0}, got {1!r}".format(
                ", ".join(ANSWER_SOURCES), declared
            )
        )
    if declared is not None:
        if ask.option_source != OPTIONS_AGENT:
            derived = "option" if ask.is_option(normalized) else "free_text"
            if declared != derived:
                raise InterviewError(
                    "answer_source {0!r} conflicts with the answer to {1}; it "
                    "arrived as {2}".format(declared, ask.id, derived)
                )
        elif declared == "option" and ask.kind != TEXT and not normalized:
            raise InterviewError(
                "an option answer for {0} cannot be empty".format(ask.id)
            )
        return declared
    if ask.option_source == OPTIONS_AGENT:
        raise InterviewError(
            "answer_source is required for {0}; pass 'option' when the customer "
            "clicked an agent-generated option or 'free_text' when they typed "
            "their own answer".format(ask.id)
        )
    return "option" if ask.is_option(normalized) else "free_text"


def record(
    bank: dict,
    doc: dict,
    ask_id: str,
    value,
    quote=None,
    inferred=None,
    answer_source=None,
):
    """Validate and persist one answer into `doc`, in place.

    Returns a dict describing what was written, for the caller to report.
    """
    ask = build_ask(bank, doc, ask_id)
    normalized = ask.validate(value, answer_source=answer_source)
    head, field = split_ask_id(ask_id)
    engagement = doc.setdefault("engagement", {})
    answers = doc.setdefault("answers", {})
    source = _answer_source(ask, normalized, answer_source)
    written = {"ask": ask_id, "stored": None, "answer_source": source}

    if head == "framing":
        if field == "language":
            engagement["language"] = normalized
        elif field == "organization":
            # The placeholder is stored as the customer-visible string it says
            # it is, so a report built before the real name arrives says so on
            # its face rather than inventing one.
            engagement["organization"] = (
                _c("org_placeholder_value", language_of(doc))
                if normalized == "placeholder"
                else normalized
            )
            normalized = engagement["organization"]
        elif field == "sector":
            engagement["sector"] = (
                ask.option("cross-sector").label
                if normalized == "cross-sector"
                else normalized
            )
            normalized = engagement["sector"]
        elif field == "roles":
            picked, typed = split_multi_answer(ask, normalized)
            engagement["participant_roles"] = picked
            engagement.pop("participant_roles_other", None)
            _unmark_asked(doc, FRAMING_PREFIX + "roles_other")
            if typed:
                # The same answer `framing.roles_other` exists to collect, so
                # collecting it here retires that question instead of asking
                # the customer for it twice.
                engagement["participant_roles_other"] = ", ".join(typed)
                _mark_asked(doc, FRAMING_PREFIX + "roles_other")
            normalized = {"roles": picked, "other": typed}
        elif field == "roles_other":
            if normalized:
                engagement["participant_roles_other"] = normalized
            else:
                engagement.pop("participant_roles_other", None)
        elif field == "focus":
            engagement["focus_pillars"] = normalized
        elif field == "tier":
            engagement["tier"] = normalized
        else:
            raise InterviewError("cannot record framing ask {0!r}".format(ask_id))
        written["stored"] = normalized
        _mark_asked(doc, ask_id)
        return written

    if field == "qb_batched":
        pillar = bank_mod.find_pillar(bank, head)
        dim_ids = [d["id"] for d in pillar.get("dimensions", [])]
        picked, typed = split_multi_answer(ask, normalized)
        mapping = parse_evidence_map("; ".join(typed), dim_ids)
        # One batched answer is replacement state for the whole pillar. An
        # omitted dimension no longer has evidence; retaining it would make a
        # revised answer silently preserve an artifact the customer withdrew.
        for dim_id in dim_ids:
            answers.setdefault(dim_id, {}).pop("evidence", None)
        for dim_id, artifact in mapping.items():
            answers.setdefault(dim_id, {})["evidence"] = artifact
        written["stored"] = {"named": mapping, "cannot_name": picked}
        _mark_asked(doc, ask_id)
        return written

    entry = answers.setdefault(head, {})
    if field == "qa":
        index = ask.option_ids.index(normalized)
        _, dimension = bank_mod.find_dimension(bank, head)
        entry["anchor"] = bank_mod.anchors(dimension)[index]["level"]
        _clear_stale_probe(dimension, entry)
        written["stored"] = entry["anchor"]
    elif field == "qb":
        if source == "option" or is_empty_answer(normalized):
            entry.pop("evidence", None)
            if source == "option":
                entry["evidence_stance"] = ask.option(normalized).label
        else:
            entry["evidence"] = normalized
            entry.pop("evidence_stance", None)
        written["stored"] = entry.get("evidence")
    elif field == "qc":
        if is_empty_answer(normalized):
            entry.pop("qc", None)
            entry.pop("qc_passed", None)
            entry.pop("qc_judgement", None)
        else:
            entry["qc"] = normalized
            if source == "option":
                # A clicked option cannot pass, whatever it says. This is the
                # channel guarantee: an agent generates the options, so the only
                # answer that reaches a judgement is one the customer typed.
                entry["qc_passed"] = False
                entry["qc_judgement"] = _c("qc_option_judgement", language_of(doc))
            elif source == "free_text":
                entry.pop("qc_passed", None)
                entry.pop("qc_judgement", None)
        written["stored"] = entry.get("qc")
    elif field == "probe2":
        if is_empty_answer(normalized):
            entry.pop("probe2", None)
        else:
            entry["probe2"] = normalized
        written["stored"] = entry.get("probe2")
    else:
        raise InterviewError("cannot record ask field {0!r}".format(field))

    if quote:
        entry["quote"] = quote
    if inferred is not None:
        if inferred:
            entry["inferred"] = True
        else:
            entry.pop("inferred", None)
    _mark_asked(doc, ask_id)
    return written


def judge_probe(doc: dict, dimension_id: str, passed: bool, rationale=None, bank=None):
    """Record the model's judgement of a Q-C answer against its pass_test.

    The invariants `score.py` enforces are enforced here too, at the point where
    the mistake would be made: a pass cannot be claimed without preserving the
    customer's answer, and a judgement cannot be recorded for a probe that the
    recorded anchor never fired.
    """
    entry = (doc.get("answers") or {}).get(dimension_id)
    if entry is None:
        raise InterviewError("no answer recorded for {0}".format(dimension_id))
    if bank is not None:
        _, dimension = bank_mod.find_dimension(bank, dimension_id)
        if not fires_probe(dimension, entry.get("anchor")):
            raise InterviewError(
                "{0} answered at {1}, so the disconfirming probe never fired and "
                "there is nothing to judge".format(dimension_id, entry.get("anchor"))
            )
    if passed and is_empty_answer(entry.get("qc")):
        raise InterviewError(
            "cannot pass the disconfirming probe for {0} without preserving a "
            "non-empty qc answer".format(dimension_id)
        )
    if "qc_passed" in entry:
        raise InterviewError(
            "the disconfirming probe for {0} is already judged; record a revised "
            "free-text answer before judging it again".format(dimension_id)
        )
    entry["qc_passed"] = bool(passed)
    if rationale:
        entry["qc_judgement"] = rationale
    return entry


# ---------------------------------------------------------------- status


def pending_judgements(bank: dict, doc: dict):
    """Dimensions whose Q-C was answered but not yet judged."""
    pending = []
    for dim_id, entry in (doc.get("answers") or {}).items():
        entry = entry or {}
        if entry.get("qc") and "qc_passed" not in entry:
            pending.append(dim_id)
    return sorted(pending)


def is_complete(bank: dict, doc: dict) -> bool:
    if next_ask_id(bank, doc) is not None:
        return False
    answers = doc.get("answers") or {}
    for dim_id in bank_mod.dimension_ids(bank):
        if (answers.get(dim_id) or {}).get("anchor") is None:
            return False
    return True


def status(bank: dict, doc: dict) -> dict:
    engagement = doc.get("engagement", {})
    answers = doc.get("answers") or {}
    complete = is_complete(bank, doc)
    upcoming = next_ask_id(bank, doc)
    per_pillar = []
    for pillar in bank_mod.pillars(bank):
        dims = [d["id"] for d in pillar.get("dimensions", [])]
        done = [d for d in dims if (answers.get(d) or {}).get("anchor") is not None]
        per_pillar.append(
            {
                "pillar": pillar["id"],
                "scored": len(done),
                "total": len(dims),
                "remaining": [d for d in dims if d not in done],
            }
        )
    return {
        "organization": engagement.get("organization"),
        "tier": engagement.get("tier"),
        "language": engagement.get("language"),
        "status": "complete" if complete else "in_progress",
        "cursor": upcoming,
        "answers_recorded": len(_asked(doc)),
        "dimensions_scored": len(
            [d for d in answers.values() if (d or {}).get("anchor") is not None]
        ),
        "dimensions_total": len(bank_mod.dimension_ids(bank)),
        "pillars": per_pillar,
        "pending_judgements": pending_judgements(bank, doc),
        "ready_to_score": complete,
    }


def resume_sentence(bank: dict, doc: dict) -> str:
    """One sentence for the facilitator, per the resume contract."""
    state = status(bank, doc)
    if state["ready_to_score"]:
        return "All {0} sub-dimensions are recorded for {1}; ready to score.".format(
            state["dimensions_total"], state["organization"] or "this engagement"
        )
    upcoming = state["cursor"]
    if upcoming is None:
        return "Nothing further to ask."
    return (
        "{0} of {1} sub-dimensions recorded for {2} at tier {3}; resuming at {4}.".format(
            state["dimensions_scored"],
            state["dimensions_total"],
            state["organization"] or "this engagement",
            state["tier"] or "unset",
            upcoming,
        )
    )
