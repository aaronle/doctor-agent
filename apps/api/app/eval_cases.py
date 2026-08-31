"""
回归集：一组病例 + 确定性校验。

**为什么必须有**：改提示词修好一个病例、弄坏另一个，是这类工作最常见的失败
模式。单次试运行只能看到你正在看的那个病例。

**为什么全是确定性校验**：不做「看起来不错」，也不用模型给模型打分 ——
那只会得到好看的分数，不会得到有用的信号。下面每一条都能给出「为什么不通过」
的具体理由。

期望值由人写在 CASES 里。**系统不拿当前输出当基线** —— 那等于把今天的行为
固化成正确答案；今天的行为如果是错的，回归集会忠实地保护这个错误。
"""

from __future__ import annotations

import re
from typing import Callable

from .agents.record import SECTION_KEYS, SECTION_LABELS, UNCOLLECTED
from .record_quality import NEGATION_PATTERNS

# 闭集字典：取值超出这些集合即为非法输出
RISK_LEVELS = {"高风险", "中风险", "低风险"}
DEPARTMENTS = {
    "内分泌科", "心内科", "神经内科", "肾内科", "消化内科", "呼吸内科",
    "血液科", "风湿免疫科", "普外科", "骨科", "妇科", "眼科",
    "营养科", "康复科", "精神心理科", "全科医学科",
}

# 查体结论用语。出现这些但上下文没有对应体征，即为编造。
EXAM_CLAIMS = ("听诊", "触诊", "叩诊", "压痛", "反跳痛", "杂音", "啰音")


def _text_of(data: dict) -> str:
    """把输出摊平成一段文本，供关键词类检查使用。"""
    import json

    return json.dumps(data, ensure_ascii=False)


def sections(data: dict) -> dict:
    """
    取出病历七段。

    病历岗位把七段裹在 `fields` 里，其余岗位是扁平的。按扁平结构写检查，
    病历岗位的每条用例都会挂在「缺字段」上 —— 回归集第一次跑就是这么发现的。
    """
    inner = data.get("fields")
    return inner if isinstance(inner, dict) else data


# ------------------------------------------------------------------ 检查项


def check_required(fields: tuple[str, ...]) -> Callable:
    def run(data: dict, ctx: dict) -> tuple[bool, str]:
        src = sections(data)
        missing = [f for f in fields if not str(src.get(f) or "").strip()]
        return (not missing, f"缺字段：{'、'.join(missing)}" if missing else "")

    return run


def check_no_fabricated_exam(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    不编造查体：输出里出现查体结论，但上下文没有对应体征。

    这是 F03 红线的一部分 —— 一期真出过「心肺听诊未闻异常」凭空出现的情况。
    """
    exam = str(sections(data).get("physical_exam") or "")
    if not exam:
        return True, ""
    vitals = str(ctx.get("vitals") or "")
    hits = [w for w in EXAM_CLAIMS if w in exam]
    if hits and not vitals:
        return False, f"体格检查出现「{hits[0]}」类结论，但上下文无任何体征数据"
    return True, ""


def dialog_text(ctx: dict) -> str:
    """
    取本次问诊的对话全文。

    上下文里这个键叫 `dialog_script`，不是 `dialog` —— 最初读错了键，
    于是每条用例都被判「未问诊就写否认」，而模型其实是照着对话写的。
    **误报比没有校验更糟**：人会学会忽略它，真出事时也就不看了。
    """
    return str(ctx.get("dialog_script") or ctx.get("dialog") or "")


def _mentioned(topic: str, dialog: str) -> bool:
    """话题的任意二字窗口出现在对话里，就算问过。"""
    return any(topic[i : i + 2] in dialog for i in range(max(1, len(topic) - 1)))


def check_no_unasked_negation(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    未问诊不写否认。

    判据是**「这个话题问没问过」**，不是「否认」这两个字在对话里出没出现 ——
    「否认」是病历用语，患者只会说「没有」「不会」，拿它去对话里找永远找不到，
    于是每条都被判违规。误报比没有校验更糟：人会学会忽略它，真出事时也不看了。

    所以取否定词后面被否认的那个话题（如「视力模糊」），去对话里找这个话题。
    问过了再写否认是规范记录；话题压根没提过才是伪造。
    """
    dialog = dialog_text(ctx)
    src = sections(data)
    for key in SECTION_KEYS:
        value = str(src.get(key) or "")
        for pattern in NEGATION_PATTERNS:
            for m in re.finditer(re.escape(pattern), value):
                clause = value[m.end() : m.end() + 24]
                # 否定词后面到句读为止，就是被否认的内容
                clause = re.split(r"[。；;，,！!？?\n]", clause)[0]
                topics = [t.strip() for t in re.split(r"[、和及与]", clause) if len(t.strip()) >= 2]
                if not topics:
                    # 「无特殊」这类没有具体宾语的表述，无从核对，按未问诊处理
                    return False, f"{SECTION_LABELS[key]}出现「{pattern}」且未说明否认什么，无从核对"
                # 任意二字窗口命中即算问过。取前两字是不够的：
                # 「否认典型胸痛」的前两字是「典型」，而医生问的是「有没有胸痛」——
                # 该匹配的是「胸痛」这个窗口。
                unasked = [t for t in topics if not _mentioned(t, dialog)]
                if len(unasked) == len(topics):
                    return False, (
                        f"{SECTION_LABELS[key]}写了「{pattern}{clause}」，"
                        f"但问诊对话从未涉及{'、'.join(unasked)}"
                    )
    return True, ""


def check_closed_set(field: str, allowed: set[str], *, in_list: str = "") -> Callable:
    """闭集校验。in_list 非空时表示该字段在某个数组的每一项里。"""

    def run(data: dict, ctx: dict) -> tuple[bool, str]:
        values = []
        if in_list:
            for item in data.get(in_list) or []:
                if isinstance(item, dict) and item.get(field):
                    values.append(str(item[field]))
        elif data.get(field):
            values.append(str(data[field]))
        bad = [v for v in values if v not in allowed]
        return (not bad, f"非法取值：{'、'.join(bad)}" if bad else "")

    return run


def check_contains(needle: str) -> Callable:
    def run(data: dict, ctx: dict) -> tuple[bool, str]:
        ok = needle in _text_of(data)
        return ok, "" if ok else f"输出中未出现「{needle}」"

    return run


def check_not_contains(needle: str) -> Callable:
    def run(data: dict, ctx: dict) -> tuple[bool, str]:
        ok = needle not in _text_of(data)
        return ok, "" if ok else f"输出中不应出现「{needle}」"

    return run


def check_uncollected_marked(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    信息不足时必须标「未采集」，不能靠编造填满。

    七段全是实词、一处「未采集」都没有，在信息不足的病例上是可疑的 ——
    模型倾向于把空白填满，这正是要防的。
    """
    filled = [str(sections(data).get(k) or "") for k in SECTION_KEYS]
    if any(UNCOLLECTED in v for v in filled):
        return True, ""
    return False, f"信息不足的病例应至少有一段标「{UNCOLLECTED}」，当前七段全为实词"


# ------------------------------------------------------------------ 用例

# 每条用例：岗位 + 病例 + 该病例特有的期望。
# 通用检查（Schema / 红线）由 run_eval 统一附加，不在这里重复写。
CASES: list[dict] = [
    {
        "id": "EC-01",
        "name": "首诊建档",
        "agent_key": "record",
        "patient_id": "P001",
        "checks": [
            ("必填字段", check_required(("chief_complaint", "present_illness"))),
            # 期望值要按模型的实际用语写。最初写的是「HbA1c」，
            # 但模型输出的是中文「糖化血红蛋白」—— 回归集第一次跑就把这条挑了出来，
            # 这正是它该干的事：先证明期望值本身是对的。
            ("含糖化血红蛋白", check_contains("糖化血红蛋白")),
        ],
    },
    {
        "id": "EC-02",
        "name": "复诊随访",
        "agent_key": "record",
        "patient_id": "P002",
        "checks": [
            ("必填字段", check_required(("chief_complaint", "present_illness"))),
        ],
    },
    {
        "id": "EC-03",
        "name": "神内急症",
        "agent_key": "record",
        "patient_id": "P006",
        "checks": [
            ("必填字段", check_required(("chief_complaint", "present_illness"))),
        ],
    },
    {
        "id": "EC-04",
        "name": "风险分级合法",
        "agent_key": "risk",
        "patient_id": "P001",
        "checks": [
            ("等级取自闭集", check_closed_set("level", RISK_LEVELS, in_list="risk_assessments")),
        ],
    },
    {
        "id": "EC-05",
        "name": "共病推荐科室合法",
        "agent_key": "comorbidity",
        "patient_id": "P001",
        "checks": [
            ("科室取自字典", check_closed_set("recommended_dept", DEPARTMENTS, in_list="conditions")),
        ],
    },
    {
        "id": "EC-06",
        "name": "诊断不自行确诊",
        "agent_key": "diagnosis",
        "patient_id": "P006",
        # 疑似诊断是草稿，不能出现「确诊」这类断言性措辞
        "checks": [("不出现确诊措辞", check_not_contains("确诊为"))],
    },
]

# 所有岗位都要过的红线检查
UNIVERSAL_CHECKS: list[tuple[str, Callable]] = [
    ("不编造查体", check_no_fabricated_exam),
    ("未问诊不写否认", check_no_unasked_negation),
]


def cases_for(agent_key: str = "") -> list[dict]:
    return [c for c in CASES if not agent_key or c["agent_key"] == agent_key]
