from typing import Any

from .schemas import CardViewModelV1, SemanticResultV1


COMPONENTS = {
    "interview_note": ("voice_interview_panel", "语音问诊"),
    "condition_summary": ("condition_summary_card", "AI 病情概况"),
    "record_draft": ("record_draft_editor", "AI 病历草稿"),
    "diagnosis_candidates": ("diagnosis_candidate_cards", "鉴别诊断"),
    "diagnosis_management": ("diagnosis_management_list", "诊断管理"),
    "risk_alert": ("risk_alert_panel", "风险管理"),
    "comorbidity_plan": ("comorbidity_plan_list", "共病管理"),
    "clarification_request": ("clarification_request_card", "需要补充信息"),
}


def _sections(result: SemanticResultV1) -> list[dict[str, Any]]:
    content = result.content
    if result.result_type == "condition_summary":
        return [
            {"key": "summary", "title": "病情摘要", "kind": "text", "value": content["summary"]},
            {"key": "problems", "title": "主要问题", "kind": "list", "value": content["problems"]},
            {
                "key": "timeline_changes",
                "title": "变化与趋势",
                "kind": "list",
                "value": content["timeline_changes"],
            },
        ]
    if result.result_type == "risk_alert":
        return [{"key": "alerts", "title": "风险项目", "kind": "risk_list", "value": content["alerts"]}]
    return [{"key": "content", "title": "结果", "kind": "structured", "value": content}]


def to_card(result: SemanticResultV1) -> CardViewModelV1:
    component, title = COMPONENTS[result.result_type]
    highest = result.safety.get("severity", "info")
    badges: list[dict[str, Any]] = []
    if result.status == "degraded":
        badges.append({"type": "status", "label": "降级结果", "level": "yellow"})
    if highest in {"critical", "warning"}:
        badges.append(
            {
                "type": "risk",
                "label": "高风险" if highest == "critical" else "中风险",
                "level": "red" if highest == "critical" else "yellow",
            }
        )
    return CardViewModelV1(
        card_id=f"card_{result.task_id}_{result.result_type}",
        task_id=result.task_id,
        component=component,
        title=title,
        status=result.status,
        badges=badges,
        meta={
            "generated_at": result.generated_at.isoformat(),
            "data_cutoff_at": result.data_cutoff_at.isoformat(),
            "version_label": f'{result.runtime["agent_id"]} {result.runtime["agent_version"]}',
        },
        sections=_sections(result),
        evidence_actions=[{"action": "view_evidence", "count": len(result.evidence_refs)}],
        primary_actions=[item for item in result.allowed_actions if item in {"accept", "edit", "acknowledge"}],
        secondary_actions=[
            item
            for item in result.allowed_actions
            if item not in {"accept", "edit", "acknowledge"}
        ],
    )
