from datetime import UTC, datetime
from typing import Any

from .schemas import SemanticResultV1, Subject, TaskRequestV1
from .agent_registry import get_agent_profile


ROUTES = {
    "voice_interview": ("voice_interview_agent", "interview_note"),
    "condition_summary": ("condition_summary_agent", "condition_summary"),
    "record_generation": ("record_generation_agent", "record_draft"),
    "differential_diagnosis": ("diagnosis_agent", "diagnosis_candidates"),
    "diagnosis_management": ("diagnosis_agent", "diagnosis_management"),
    "risk_management": ("risk_management_agent", "risk_alert"),
    "comorbidity_management": ("comorbidity_agent", "comorbidity_plan"),
}

ICD_CODES = {
    "2型糖尿病（血糖控制不佳）": "E11.9",
    "糖尿病肾病（早期）": "E11.2",
    "糖尿病视网膜病变（NPDR轻度）": "E11.3",
    "膝骨关节炎": "M17.9",
    "半月板损伤": "S83.2",
    "炎性关节病待排": "M13.9",
    "马尾综合征": "G83.4",
    "脊髓/神经根严重受压": "G54.4",
    "异常子宫出血": "N93.9",
    "子宫内膜病变待排": "N85.9",
    "子宫肌瘤/腺肌病待排": "D25.9",
    "异位妊娠破裂": "O00.9",
}

LAB_LABELS: dict[str, tuple[str, str]] = {
    "fasting_glucose_mmol_l": ("空腹血糖", "mmol/L"),
    "hba1c_percent": ("HbA1c", "%"),
    "uacr_mg_g": ("UACR", "mg/g"),
    "egfr_ml_min": ("eGFR", "mL/min"),
    "hemoglobin_g_l": ("血红蛋白", "g/L"),
}


def _lab_evidence(facts: dict[str, Any], keys: list[str] | None = None) -> list[str]:
    labs = facts.get("labs", {})
    selected = keys or list(labs)
    values = []
    for key in selected:
        if key not in labs:
            continue
        label, unit = LAB_LABELS.get(key, (key, ""))
        values.append(f"{label} {labs[key]}{unit}")
    return values


def _risk_evidence(title: str, fixture: dict[str, Any]) -> list[str]:
    facts = fixture.get("facts", {})
    if "血糖" in title or "低血糖" in title:
        evidence = _lab_evidence(facts, ["fasting_glucose_mmol_l", "hba1c_percent"])
    elif "肾" in title:
        evidence = _lab_evidence(facts, ["uacr_mg_g", "egfr_ml_min"])
    elif "视网膜" in title or "眼" in title:
        evidence = list(map(str, facts.get("exams", [])))
    elif "贫血" in title:
        evidence = _lab_evidence(facts, ["hemoglobin_g_l"])
    else:
        evidence = [
            *_lab_evidence(facts),
            *map(str, facts.get("exams", [])),
            *map(str, facts.get("red_flags", [])),
            *map(str, facts.get("conflicts", [])),
        ]
    return evidence[:4] or [fixture["encounter"]["chief_complaint"]]


def _risk_recommendation(title: str, critical: bool) -> str:
    if critical:
        return "立即核实红旗征象、生命体征与关键检查，并记录升级处置"
    if "血糖" in title:
        return "强化生活方式干预，复核降糖方案并按随访计划复查 HbA1c"
    if "肾" in title:
        return "严格控制血压与血糖，复核护肾用药并随访 UACR 和肾功能"
    if "视网膜" in title or "眼" in title:
        return "安排眼科随访，并同步控制血糖、血压和血脂"
    if "贫血" in title:
        return "复查血常规并评估出血原因、症状程度及是否需要紧急处理"
    return "请结合原始资料完成专科评估并确认处置计划"


def _diagnosis_evidence(name: str, fixture: dict[str, Any]) -> list[str]:
    facts = fixture.get("facts", {})
    evidence = [fixture["encounter"]["chief_complaint"]]
    if "糖尿病肾病" in name:
        evidence = _lab_evidence(facts, ["uacr_mg_g", "egfr_ml_min"])
    elif "视网膜" in name:
        evidence = list(map(str, facts.get("exams", [])))
    elif "糖尿病" in name:
        evidence = _lab_evidence(facts, ["fasting_glucose_mmol_l", "hba1c_percent"])
    elif "贫血" in name:
        evidence = _lab_evidence(facts, ["hemoglobin_g_l"])
    elif "马尾" in name or "神经根" in name or "异位妊娠" in name:
        evidence = list(map(str, facts.get("red_flags", [])))
    elif facts.get("symptoms") or facts.get("exams"):
        evidence = [*map(str, facts.get("symptoms", [])), *map(str, facts.get("exams", []))]
    return evidence[:4] or [fixture["encounter"]["chief_complaint"]]


def _evidence(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    facts = fixture.get("facts", {})
    evidence: list[dict[str, Any]] = []
    for key in ("labs", "exams", "diagnoses", "medications", "symptoms", "red_flags"):
        if key in facts:
            evidence.append(
                {
                    "ref_id": f'{fixture["fixture_id"]}:{key}',
                    "source_type": key,
                    "label": key,
                    "recorded_at": "2026-08-28T08:00:00+08:00",
                    "value": facts[key],
                }
            )
    if not evidence:
        evidence.append(
            {
                "ref_id": f'{fixture["fixture_id"]}:encounter',
                "source_type": "encounter",
                "label": "本次就诊",
                "recorded_at": "2026-08-28T08:00:00+08:00",
                "value": fixture["encounter"]["chief_complaint"],
            }
        )
    return evidence


def _summary_content(fixture: dict[str, Any]) -> dict[str, Any]:
    expected = fixture.get("expected", {})
    facts = fixture.get("facts", {})
    problems = expected.get("summary_problems") or expected.get("must_clarify") or []
    if not problems:
        problems = expected.get("differential_candidates", [])[:4]
    one_line = (
        f'{fixture["patient"]["age"]}岁{fixture["patient"]["gender"]}性，'
        f'本次因“{fixture["encounter"]["chief_complaint"]}”就诊。'
    )
    if problems:
        one_line += f'当前重点包括：{"、".join(problems[:4])}。'
    changes: list[str] = []
    labs = facts.get("labs", {})
    if labs:
        changes.append("本次关键检验已纳入概况，数值与单位可在证据中复核")
    if facts.get("red_flags"):
        changes.append("本次新增红旗信息，已同步进入风险管理")
    return {
        "summary": one_line,
        "problems": problems,
        "timeline_changes": changes,
        "treatment_plan": _treatment_plan(fixture),
    }


def _treatment_plan(fixture: dict[str, Any]) -> dict[str, Any]:
    specialty = fixture.get("specialty", "")
    facts = fixture.get("facts", {})
    medications: list[dict[str, str]] = []
    examinations: list[dict[str, str]] = []

    if "内科" in specialty:
        medications = [
            {
                "name": "达格列净片",
                "dose": "10mg",
                "frequency": "qd",
                "route": "口服",
                "basis": "结合血糖控制及肾脏风险评估，可考虑 SGLT-2 抑制剂",
            },
            {
                "name": "瑞舒伐他汀钙片",
                "dose": "10mg",
                "frequency": "qn",
                "route": "口服",
                "basis": "血脂风险需进一步控制，具体方案由医生结合既往用药确认",
            },
        ]
        examinations = [
            {"name": "空腹血糖复查", "type": "检验", "timing": "门诊 · 一次", "basis": "评估近期血糖控制"},
            {"name": "糖化血红蛋白复查", "type": "检验", "timing": "按随访计划", "basis": "评估阶段性降糖效果"},
        ]
    elif "骨科" in specialty:
        medications = [
            {
                "name": "镇痛治疗方案（待确认）",
                "dose": "按病情",
                "frequency": "按需",
                "route": "口服或局部",
                "basis": "需结合疼痛程度、抗凝用药及肾功能选择",
            }
        ]
        examinations = [
            {"name": "专科查体与影像复核", "type": "检查", "timing": "本次就诊", "basis": "明确结构性病变与处置路径"}
        ]
    elif "妇科" in specialty:
        medications = [
            {
                "name": "对症治疗方案（待确认）",
                "dose": "按病情",
                "frequency": "按医嘱",
                "route": "由医生确认",
                "basis": "先完成妊娠状态、出血风险及贫血程度评估",
            }
        ]
        examinations = [
            {"name": "血常规复查", "type": "检验", "timing": "本次就诊", "basis": "评估贫血或活动性出血"},
            {"name": "妇科超声复核", "type": "检查", "timing": "尽快", "basis": "结合症状排查器质性病变"},
        ]

    if facts.get("red_flags"):
        examinations.insert(
            0,
            {
                "name": "红旗征象紧急复核",
                "type": "急诊评估",
                "timing": "立即",
                "basis": "存在可能影响处置优先级的红旗信息",
            },
        )
    return {
        "medications": medications,
        "examinations": examinations,
        "notice": "以上为诊疗建议草案，开立前须由医生核对适应证、禁忌证、剂量及患者意愿。",
    }


def _risk_content(fixture: dict[str, Any]) -> tuple[dict[str, Any], str, bool]:
    expected = fixture.get("expected", {})
    facts = fixture.get("facts", {})
    critical_title = expected.get("critical_risk")
    warning_titles = expected.get("critical_or_warning_risks") or expected.get("risks") or []
    titles = ([critical_title] if critical_title else []) + warning_titles
    if not titles and facts.get("red_flags"):
        titles = facts["red_flags"]
    if not titles:
        titles = ["当前未发现阻断性红旗，仍需医生结合原始资料复核"]
    blocking = bool(expected.get("write_back_blocked") or critical_title)
    alerts = []
    for index, title in enumerate(titles):
        critical = blocking and index == 0
        alerts.append(
            {
                "risk_id": f'{fixture["fixture_id"]}-R{index + 1:02d}',
                "title": title,
                "severity": "critical" if critical else ("warning" if warning_titles else "information"),
                "status": "new",
                "evidence": _risk_evidence(title, fixture),
                "recommended_action": _risk_recommendation(title, critical),
                "due_label": "立即" if critical else "本次就诊内",
                "source": "安全规则 + 风险管理智能体" if critical else "风险管理智能体",
                "category": "专病与诊疗安全",
                "impact": (
                    "未闭环前阻断病历与诊断关键提交"
                    if critical
                    else "提交前须处理、确认已阅或有因留痕"
                ),
                "threshold": (
                    "红色组合风险：急危重线索或严重伤害可能性，需要立即处置"
                    if critical
                    else "黄色组合风险：需要本次就诊内评估、处理或留痕"
                ),
                "uncertainty": "仍需结合原始病历、检验检查、专科查体和医生临床判断复核",
                "assessment_refs": ["专病风险评估"],
                "skill_refs": ["并发症风险筛查", "用药审核优化"],
            }
        )
    severity = "critical" if blocking else ("warning" if warning_titles else "info")
    return {"alerts": alerts, "highest_severity": severity}, severity, blocking


def _generic_content(
    task_type: str,
    fixture: dict[str, Any],
    supplemental_observations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    expected = fixture.get("expected", {})
    facts = fixture.get("facts", {})
    fixture_id = fixture["fixture_id"]
    chief_complaint = fixture["encounter"]["chief_complaint"]
    source_refs = [item["ref_id"] for item in _evidence(fixture)]
    supplemental_observations = supplemental_observations or []
    observation_refs = [item["observation_id"] for item in supplemental_observations]
    observation_texts = [item["text"] for item in supplemental_observations]
    if task_type == "voice_interview":
        key_detail = (
            (facts.get("red_flags") or facts.get("symptoms") or facts.get("conflicts") or [chief_complaint])[0]
        )
        low_confidence = bool(facts.get("conflicts") or facts.get("missing"))
        transcript_segments = [
                {
                    "segment_id": f"{fixture_id}-S01",
                    "speaker": "doctor",
                    "started_at_seconds": 0,
                    "text": "您好，请描述一下这次最主要的不舒服。",
                    "confidence": 0.99,
                },
                {
                    "segment_id": f"{fixture_id}-S02",
                    "speaker": "patient",
                    "started_at_seconds": 4,
                    "text": chief_complaint,
                    "confidence": 0.96,
                },
                {
                    "segment_id": f"{fixture_id}-S03",
                    "speaker": "doctor",
                    "started_at_seconds": 11,
                    "text": "还有没有其他变化或需要特别说明的情况？",
                    "confidence": 0.98,
                },
                {
                    "segment_id": f"{fixture_id}-S04",
                    "speaker": "patient",
                    "started_at_seconds": 16,
                    "text": str(key_detail),
                    "confidence": 0.72 if low_confidence else 0.94,
                },
            ]
        transcript_segments.extend(
            {
                "segment_id": observation["observation_id"],
                "speaker": "doctor",
                "started_at_seconds": 24 + index,
                "text": f'【补充观察】{observation["text"]}',
                "confidence": 1.0,
                "source": observation.get("source", "doctor_selected"),
            }
            for index, observation in enumerate(supplemental_observations)
        )
        clinical_entities = [
                {"type": "chief_complaint", "value": chief_complaint, "source_segment_id": f"{fixture_id}-S02"},
                {"type": "key_detail", "value": str(key_detail), "source_segment_id": f"{fixture_id}-S04"},
            ]
        clinical_entities.extend(
            {
                "type": "supplemental_observation",
                "value": observation["text"],
                "source_segment_id": observation["observation_id"],
            }
            for observation in supplemental_observations
        )
        return {
            "transcript_segments": transcript_segments,
            "clinical_entities": clinical_entities,
            "structured_history": {
                "chief_complaint": chief_complaint,
                "present_illness": [str(key_detail)],
                "allergy": fixture["encounter"]["allergy"],
                "medications": facts.get("medications", []),
                "supplemental_observations": observation_texts,
            },
            "clarifications": expected.get("must_clarify") or facts.get("missing") or [],
            "recording": {"duration_seconds": 24, "audio_persisted": False, "mock_source": "fixed_transcript"},
        }
    if task_type == "record_generation":
        history_parts = facts.get("symptoms") or facts.get("red_flags") or facts.get("diagnoses") or []
        history = f"患者因{chief_complaint}就诊。"
        if history_parts:
            history += f'相关资料提示：{"；".join(map(str, history_parts[:4]))}。'
        if observation_texts:
            history += f'医生补充观察：{"；".join(observation_texts)}。'
        personal_history = (
            "吸烟史10年，约10支/天；偶有饮酒。否认毒物、粉尘接触史。"
            if fixture_id == "IM-001"
            else "个人史尚未完整采集，请医生结合问诊补充"
        )
        exam_items = list(map(str, facts.get("exams", [])))
        lab_display = {
            "fasting_glucose_mmol_l": ("空腹血糖", "mmol/L"),
            "hba1c_percent": ("HbA1c", "%"),
            "uacr_mg_g": ("UACR", "mg/g"),
            "egfr_ml_min": ("eGFR", "mL/min"),
            "hemoglobin_g_l": ("血红蛋白", "g/L"),
        }
        lab_items = [
            f"{lab_display.get(name, (name, ''))[0]}：{value}{lab_display.get(name, (name, ''))[1]}"
            for name, value in facts.get("labs", {}).items()
        ]
        auxiliary_exam = "；".join([*exam_items, *lab_items]) or "本次辅助检查资料尚未完整录入"
        return {
            "sections": [
                {"section_id": "chief_complaint", "title": "主诉", "ai_text": chief_complaint, "status": "generated", "source_refs": [f"{fixture_id}:encounter"]},
                {"section_id": "present_illness", "title": "现病史", "ai_text": history, "status": "generated", "source_refs": [*source_refs, *observation_refs]},
                {"section_id": "past_history", "title": "既往史", "ai_text": "；".join(facts.get("diagnoses", [])) or "可用资料不足，需医生补充", "status": "needs_input" if not facts.get("diagnoses") else "generated", "source_refs": [f"{fixture_id}:diagnoses"] if facts.get("diagnoses") else []},
                {"section_id": "personal_history", "title": "个人史", "ai_text": personal_history, "status": "generated" if fixture_id == "IM-001" else "needs_input", "source_refs": [f"{fixture_id}:voice"] if fixture_id == "IM-001" else []},
                {"section_id": "allergy", "title": "过敏史", "ai_text": fixture["encounter"]["allergy"], "status": "generated", "source_refs": [f"{fixture_id}:encounter"]},
                {"section_id": "physical_exam", "title": "体格检查", "ai_text": "本次体格检查尚未录入，请医生补充", "status": "needs_input", "source_refs": []},
                {"section_id": "auxiliary_exam", "title": "辅助检查", "ai_text": auxiliary_exam, "status": "generated" if exam_items or lab_items else "needs_input", "source_refs": source_refs},
                {"section_id": "assessment", "title": "初步诊断", "ai_text": "；".join(expected.get("differential_candidates", [])[:2]) or "待医生结合检查确认", "status": "generated", "source_refs": source_refs},
            ],
            "validation": {
                "complete": False,
                "score": 72,
                "issues": ["体格检查待补充", *facts.get("missing", [])],
                "message": "病历草稿已生成，必须由医生逐段复核",
            },
            "source_map": [*source_refs, *observation_refs],
            "template": {"template_id": f"outpatient-{fixture['specialty']}", "template_version": "mock-0.1"},
        }
    if task_type == "differential_diagnosis":
        cannot_miss = expected.get("cannot_miss", [])
        names = cannot_miss + [
            item for item in expected.get("differential_candidates", []) if item not in cannot_miss
        ]
        if not names:
            names = expected.get("summary_problems", [])[:3] or ["需结合进一步资料形成鉴别诊断"]
        candidates = []
        for index, name in enumerate(names[:6]):
            priority = "must_not_miss" if name in cannot_miss else ("likely" if index == 0 else "possible")
            evidence = _diagnosis_evidence(name, fixture)
            candidates.append(
                {
                    "candidate_id": f"{fixture_id}-DX{index + 1:02d}",
                    "name": name,
                    "priority": priority,
                    "icd_candidates": [{"code": ICD_CODES.get(name, "待匹配"), "version": "院内术语服务待接入", "confirmed": False}],
                    "confidence": max(0.62, 0.92 - index * 0.09),
                    "supporting_evidence": [
                        {"text": text, "source_ref": source_refs[0] if source_refs else f"{fixture_id}:encounter"}
                        for text in evidence
                    ],
                    "opposing_evidence": ["未获得明确反对证据"],
                    "missing_information": facts.get("missing", []) or expected.get("must_clarify", []),
                    "risk_links": [expected.get("critical_risk")] if priority == "must_not_miss" and expected.get("critical_risk") else [],
                    "next_steps": ["补充专科查体与必要检查，具体项目由医生确认"],
                    "uncertainty": "AI 建议，需医生结合原始资料判断",
                }
            )
        return {
            "candidates": candidates,
            "next_steps": expected.get("must_clarify") or facts.get("missing") or ["结合专科查体进一步判断"],
        }
    if task_type == "diagnosis_management":
        candidates = expected.get("differential_candidates") or expected.get("cannot_miss") or []
        diagnoses = [
            {
                "diagnosis_id": f"{fixture_id}-D{index + 1:02d}",
                "name": name,
                "icd_code": "待术语服务确认",
                "status": "provisional" if index == 0 else "rule_out",
                "is_primary": index == 0,
                "source": "诊断智能体",
                "consistency": "needs_review" if facts.get("conflicts") else "consistent",
            }
            for index, name in enumerate(candidates[:5])
        ]
        return {
            "diagnoses": diagnoses,
            "primary": diagnoses[:1],
            "secondary": [item for item in diagnoses[1:] if item["status"] != "rule_out"],
            "to_rule_out": [item for item in diagnoses if item["status"] == "rule_out"],
            "changes": [],
            "validation": {"primary_unique": True, "coding_ready": False, "issues": ["ICD 编码待本地术语服务确认"]},
        }
    if task_type == "comorbidity_management":
        names = expected.get("comorbidities") or facts.get("diagnoses") or []
        interactions = expected.get("comorbidity_interactions") or []
        conditions = [
            {
                "problem_id": f"{fixture_id}-C{index + 1:02d}",
                "name": name,
                "status": "confirmed" if name in facts.get("diagnoses", []) else "suspected",
                "group": "current_relevant" if index < 3 else "stable_history",
                "relevance": interactions[index] if index < len(interactions) else f"可能影响本次{fixture['specialty']}诊疗决策",
                "control_status": "unknown" if facts.get("missing") else ("uncontrolled" if index == 0 else "controlled"),
                "evidence": source_refs[:2],
                "interactions": interactions,
                "care_gaps": facts.get("missing", [])[:2] or ["需核实近期随访与控制目标"],
                "suggested_actions": ["复制到处理意见", "创建模拟随访"],
                "risk_links": [expected.get("critical_risk")] if expected.get("critical_risk") else [],
            }
            for index, name in enumerate(names[:6])
        ]
        return {
            "conditions": conditions,
            "care_gaps": facts.get("missing", []),
            "actions": ["形成随访或会诊草稿，提交前由医生确认"] if conditions else ["可用资料不足，需人工维护共病清单"],
        }
    raise ValueError(f"Unsupported task type: {task_type}")


def build_result(
    *, task_id: str, request: TaskRequestV1, fixture: dict[str, Any], scenario: str = "success"
) -> SemanticResultV1:
    agent_id, result_type = ROUTES[request.task_type]
    agent_profile = get_agent_profile(request.task_type)
    severity = "info"
    blocking = False
    facts = fixture.get("facts", {})
    supplemental_observations = [
        item.model_dump(mode="json") for item in request.interaction_context.supplemental_observations
    ]
    result_conflicts = list(facts.get("conflicts", []))
    if scenario == "data_conflict" and not result_conflicts:
        result_conflicts = ["Mock 冲突：患者自述与历史记录不一致，禁止静默合并"]
    if scenario == "clarification_required":
        result_type = "clarification_request"
        questions = fixture.get("expected", {}).get("must_clarify") or facts.get("missing") or ["请补充本次关键症状的发生时间和程度"]
        content = {
            "questions": [{"question_id": f"Q{index + 1}", "text": question, "blocking": index == 0} for index, question in enumerate(questions[:4])],
            "blocking_fields": [questions[0]],
            "reason": "缺少会影响当前任务安全性的关键上下文",
        }
        severity = "warning"
        blocking = True
    elif request.task_type == "condition_summary":
        content = _summary_content(fixture)
    elif request.task_type == "risk_management":
        content, severity, blocking = _risk_content(fixture)
    else:
        content = _generic_content(request.task_type, fixture, supplemental_observations)
    evidence_refs = _evidence(fixture)
    evidence_refs.extend(
        {
            "ref_id": item["observation_id"],
            "source_type": "doctor_supplemental_observation",
            "title": "医生补充观察",
            "occurred_at": item["occurred_at"],
            "text": item["text"],
        }
        for item in supplemental_observations
    )
    return SemanticResultV1(
        task_id=task_id,
        task_type=request.task_type,
        result_type=result_type,
        status=("needs_clarification" if scenario == "clarification_required" else "degraded" if scenario == "degraded_result" else "ready"),
        subject=Subject(**request.subject.model_dump()),
        generated_at=datetime.now(UTC),
        data_cutoff_at=request.context_ref.data_cutoff_at,
        runtime={
            "mode": "mock_agent",
            "agent_id": agent_id,
            "agent_name": agent_profile.display_name,
            "agent_version": agent_profile.version,
        },
        content=content,
        evidence_refs=evidence_refs,
        missing_data=facts.get("missing", []),
        conflicts=result_conflicts,
        safety={"severity": severity, "requires_acknowledgement": severity != "info", "blocking": blocking},
        uncertainties=["这是版本化 Mock 降级结果，内容可能不完整"] if scenario == "degraded_result" else [],
        allowed_actions=(
            ["retry"]
            if scenario == "clarification_required"
            else
            ["acknowledge", "start_action", "resolve", "false_positive", "dismiss_with_reason", "retry"]
            if request.task_type == "risk_management"
            else ["accept", "partial_accept", "edit", "reject", "report_error", "retry"]
        ),
        trace_id=request.trace_id,
    )
