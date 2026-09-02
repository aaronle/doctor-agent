"""
回归集：一组病例 + 确定性校验。

**为什么必须有**：改提示词修好一个病例、弄坏另一个，是这类工作最常见的失败
模式。单次试运行只能看到你正在看的那个病例。

**为什么全是确定性校验**：不做「看起来不错」，也不用模型给模型打分 ——
那只会得到好看的分数，不会得到有用的信号。下面每一条都能给出「为什么不通过」
的具体理由。

期望值由人写在 `data/eval_datasets/*.json` 里，本模块只提供**检查项的实现**
与一张 kind→函数 的注册表（见文件末尾）。**系统不拿当前输出当基线** ——
那等于把今天的行为固化成正确答案；今天的行为如果是错的，回归集会忠实地
保护这个错误。

用例的加载、启停与编译在 `eval_datasets.py`。
"""

from __future__ import annotations

import json
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


def _mentioned(topic: str, corpus: str) -> bool:
    """话题的任意二字窗口出现在语料里，就算有出处。"""
    return any(topic[i : i + 2] in corpus for i in range(max(1, len(topic) - 1)))


# 主档里**已经记载**的病史。写在这些字段里的否认是既有记录，不是本次编造。
DOCUMENTED_HISTORY_FIELDS = ("past_history", "allergies", "personal_history", "primary_diagnosis")


def documented_history(ctx: dict) -> str:
    """
    患者主档里既有的病史文本。

    与对话并列作为「否认」的合法出处 —— **既往史本来就不是每次就诊都重问一遍的东西**。
    P005 的主档既往史原文就是「否认其他慢病史，家族有糖尿病史（父亲）」，模型照抄
    是正确行为；只看对话的话，这会被判成伪造。这正是回归集扩到七个病例后抓出来的
    第一个问题 —— 抓的不是模型，是校验本身。
    """
    parts = []
    for key in DOCUMENTED_HISTORY_FIELDS:
        value = ctx.get(key)
        if isinstance(value, (list, tuple)):
            parts.extend(str(v) for v in value)
        elif value:
            parts.append(str(value))
    return "".join(parts)


def check_no_unasked_negation(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    未问诊不写否认。

    判据是**「这个话题问没问过」**，不是「否认」这两个字在对话里出没出现 ——
    「否认」是病历用语，患者只会说「没有」「不会」，拿它去对话里找永远找不到，
    于是每条都被判违规。误报比没有校验更糟：人会学会忽略它，真出事时也不看了。

    所以取否定词后面被否认的那个话题（如「视力模糊」），去**本次对话**和
    **主档既有病史**里找这个话题。问过了、或主档本来就记着，再写否认都是
    规范记录；两处都没有才是伪造。
    """
    corpus = dialog_text(ctx) + documented_history(ctx)
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
                unsourced = [t for t in topics if not _mentioned(t, corpus)]
                if len(unsourced) == len(topics):
                    return False, (
                        f"{SECTION_LABELS[key]}写了「{pattern}{clause}」，"
                        f"但问诊对话与主档病史均未涉及{'、'.join(unsourced)}"
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


# ------------------------------------------------- 《病历书写基本规范》字段要求

"""
以下两条检查的依据是原卫生部《病历书写基本规范》第二章对门急诊病历的规定。

**为什么单独一组**：其余检查项的期望值是我们自己定的「应该这样」，这一组的
期望值来自规范条文，性质不同 —— 它是外部标准，不是内部偏好。

规范原文要求：
  初诊：就诊时间、科别、主诉、现病史、既往史、阳性体征、必要的阴性体征、
        辅助检查结果、诊断、治疗意见、医师签名
  复诊：就诊时间、科别、主诉、病史、必要的体格检查、辅助检查结果、
        诊断、治疗处理意见、医师签名

其中**就诊时间、科别、医师签名由系统提供，不是模型产出**，因此不放进模型
输出的校验里，另由 spec_visit_metadata 校验患者主档。
"""

# 规范要求落到我们七段上的映射。初诊比复诊多一条既往史 ——
# 规范对复诊只要求「病史」，不单列既往史。
SPEC_FIELDS_FIRST_VISIT = (
    "chief_complaint", "present_illness", "past_history",
    "physical_exam", "auxiliary_exam", "preliminary_diagnosis",
)
SPEC_FIELDS_RETURN_VISIT = (
    "chief_complaint", "present_illness",
    "physical_exam", "auxiliary_exam", "preliminary_diagnosis",
)


def _is_return_visit(ctx: dict) -> bool:
    return bool(ctx.get("is_return_visit"))


def check_spec_required_fields(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    规范要求的段落必须存在。

    **「未采集」算存在**：规范要的是「有这一栏并作了交代」，如实写未采集
    是合规记录；真正违规的是整段留空，那等于这次就诊没记这一项。
    """
    required = SPEC_FIELDS_RETURN_VISIT if _is_return_visit(ctx) else SPEC_FIELDS_FIRST_VISIT
    kind = "复诊" if _is_return_visit(ctx) else "初诊"
    src = sections(data)
    missing = [SECTION_LABELS.get(f, f) for f in required if not str(src.get(f) or "").strip()]
    if missing:
        return False, f"{kind}病历缺规范要求的段落：{'、'.join(missing)}"
    return True, ""


# 有这些上下文数据，对应段落就不该写「未采集」
SPEC_EVIDENCE_FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("auxiliary_exam", ("lab_results", "examinations")),
    ("past_history", ("past_history",)),
)


#: 一句话里出现这些字样，就认为这句只是在交代「这一项没有」，不承载内容。
#: 模型的措辞不统一（未采集 / 未获得 / 未提供 都出现过），按语义收口而不是只认一种。
_NO_CONTENT_MARKERS = (UNCOLLECTED, "未获得", "未提供", "未记录")

#: 断句用。中英文标点都算，模型两种都会用。
_CLAUSE_SEPARATORS = "。；;，,\n"


def _has_substantive_content(text: str) -> bool:
    """
    去掉「××未采集」这类交代性小句之后，这一段还剩不剩实质内容。

    **按小句判，不按整段找子串。** 这是 2026-09-02 修的一个假失败：
    既往史写成「高血压10年，血压控制差；2型糖尿病8年，规律服药；过敏史未采集」——
    主档的既往史一字不落地记下来了，只是**如实交代了过敏史没采集**
    （主档 allergies 确实是空的，此时写「否认过敏史」才是伪造问诊）。
    原来的判据是「整段里出现过『未采集』就算漏记」，于是把一个完全正确的
    输出判成了不合格。

    这不是把闸放松：整段只写「未采集」照样判失败（见
    `test_blank_section_with_evidence_still_fails`）。改的是**判据的粒度** ——
    要判的是「这一段有没有记下该记的东西」，不是「这三个字有没有出现过」。
    """
    for raw in "".join(ch if ch not in _CLAUSE_SEPARATORS else "\n" for ch in text).split("\n"):
        clause = raw.strip(" 　、：:()（）")
        if not clause:
            continue
        if any(marker in clause for marker in _NO_CONTENT_MARKERS):
            continue
        return True
    return False


def check_spec_no_blank_with_evidence(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    上下文里有料，对应段落就不能是空的。

    这一条才是有牙齿的那个：`check_spec_required_fields` 只看栏目在不在，
    模型把七段全填「未采集」也能过。而患者明明有 9 项异常检验，辅助检查
    却写「未采集」，那是漏记，规范意义上的不合格。
    """
    src = sections(data)
    bad = []
    for field, evidence_keys in SPEC_EVIDENCE_FIELDS:
        value = str(src.get(field) or "")
        if _has_substantive_content(value):
            continue
        has_evidence = any(ctx.get(k) for k in evidence_keys)
        if has_evidence:
            bad.append(SECTION_LABELS.get(field, field))
    if bad:
        return False, f"上下文有对应数据，但这些段落没有记下任何实质内容：{'、'.join(bad)}"
    return True, ""


def check_spec_visit_metadata(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    规范要求的就诊时间与科别。

    **这两项校验的是系统，不是模型** —— 它们由 HIS 主档提供，模型既不产出
    也无从伪造。放进回归集是因为规范把它们列为必备项，缺了同样不合格；
    真缺的话是种子数据的问题，而不是提示词的问题。

    规范里的第三项「医师签名」**不在这里校验**：`doctor` 刻意不进 Agent 上下文
    （见 context.py 的裁剪清单 —— 模型用不上的字段不该进提示词）。硬查一个
    上下文里没有的键，结果是每条用例都挂在同一条误报上，而误报比没有校验更糟：
    人会学会忽略它，真出事时也就不看了。医师签名由 HIS 主档与审计链保证。
    """
    missing = [
        label for label, key in (("就诊时间", "visit_date"), ("科别", "dept"))
        if not str(ctx.get(key) or "").strip()
    ]
    if missing:
        return False, f"患者主档缺规范要求的项：{'、'.join(missing)}（由 HIS 提供，非模型产出）"
    return True, ""


# 所有岗位都要过的红线检查
UNIVERSAL_CHECKS: list[tuple[str, Callable]] = [
    ("不编造查体", check_no_fabricated_exam),
    ("未问诊不写否认", check_no_unasked_negation),
]




# ------------------------------------------------------------------ 检查项注册表

"""
数据集里的检查项以「名字 + 参数」声明，由这张表映射到上面的函数。

**为什么不直接在 JSON 里写代码**：那意味着 eval 任意字符串，等于给数据文件
开了一个执行入口。数据集将来可能来自外部导入，这个口子不能开。

注册表之外的 kind 一律**加载失败并报出来**，不静默跳过 —— 静默跳过会让
一条本该跑的检查悄悄消失，而报告上看起来一切正常。
"""

CLOSED_SETS: dict[str, set[str]] = {
    "risk_levels": RISK_LEVELS,
    "departments": DEPARTMENTS,
}


def _build_required_fields(args: dict) -> Callable:
    return check_required(tuple(args.get("fields") or ()))


def _build_contains(args: dict) -> Callable:
    return check_contains(str(args["needle"]))


def _build_not_contains(args: dict) -> Callable:
    return check_not_contains(str(args["needle"]))


def _build_closed_set(args: dict) -> Callable:
    name = str(args["allowed"])
    if name not in CLOSED_SETS:
        raise ValueError(f"未知闭集「{name}」，可用：{'、'.join(CLOSED_SETS)}")
    return check_closed_set(str(args["field"]), CLOSED_SETS[name], in_list=str(args.get("in_list") or ""))


CHECK_REGISTRY: dict[str, Callable[[dict], Callable]] = {
    "required_fields": _build_required_fields,
    "contains": _build_contains,
    "not_contains": _build_not_contains,
    "closed_set": _build_closed_set,
    "uncollected_marked": lambda args: check_uncollected_marked,
    "no_fabricated_exam": lambda args: check_no_fabricated_exam,
    "no_unasked_negation": lambda args: check_no_unasked_negation,
    "spec_required_fields": lambda args: check_spec_required_fields,
    "spec_no_blank_with_evidence": lambda args: check_spec_no_blank_with_evidence,
    "spec_visit_metadata": lambda args: check_spec_visit_metadata,
}


def build_check(spec: dict) -> tuple[str, Callable]:
    """把一条声明式检查项编译成 (显示名, 可调用)。kind 不认识就抛。"""
    kind = str(spec.get("kind") or "")
    builder = CHECK_REGISTRY.get(kind)
    if builder is None:
        raise ValueError(f"未知检查项 kind「{kind}」，可用：{'、'.join(sorted(CHECK_REGISTRY))}")
    name = str(spec.get("name") or kind)
    return name, builder(spec.get("args") or {})


# ---------------------------------------------------------------- 风险管理


#: 只把「有区分度」的数字算数。单个数字（2、5）在任何上下文里都能撞上，
#: 拿它判「有没有引用依据」等于没判。两位以上或带小数点的才算。
_MEANINGFUL_NUMBER = re.compile(r"\d+\.\d+|\d{2,}")


def _context_numbers(ctx: dict) -> set[str]:
    """上下文里出现过的所有有区分度的数字，按去掉末尾零后的形式归一。"""
    blob = json.dumps(ctx, ensure_ascii=False)
    return {_norm_number(n) for n in _MEANINGFUL_NUMBER.findall(blob)}


def _norm_number(text: str) -> str:
    """8.50 与 8.5 是同一个数。不归一的话「引用了原文」会被判成「编造」。"""
    if "." in text:
        return text.rstrip("0").rstrip(".")
    return text


def _risk_items(data: dict) -> list[dict]:
    items = data.get("risk_assessments")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def check_risk_evidence_grounded(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    依据里出现的数字，**必须在上下文里找得到**。

    这是编造检测，不是质量检测：模型写「HbA1c 9.2%」而档案里是 8.6%，
    医生照着这条判断就是错的。比「没写数值」严重得多，所以单列一条。
    """
    known = _context_numbers(ctx)
    bad: list[str] = []
    for item in _risk_items(data):
        text = f"{item.get('evidence', '')} {item.get('assessment', '')}"
        for raw in _MEANINGFUL_NUMBER.findall(text):
            if _norm_number(raw) not in known:
                bad.append(f"{item.get('name', '?')}：{raw}")
    if bad:
        return False, f"依据里的数字在上下文中不存在（疑似编造）：{'；'.join(bad[:4])}"
    return True, ""


def check_risk_evidence_quantified(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    **至少半数风险项要引用具体数值。**

    这一条是冲着「四条空话」去的 —— 「血糖控制不佳」「注意血压」这种
    没有数值的判断，医生无法复核，也无从据此决定下一步。
    换模型时这正是最先退化、也最不容易被别的校验抓到的东西。

    不要求每一条都带数字：确实存在合理的定性风险项（如依从性），
    一刀切会逼出编造。
    """
    items = _risk_items(data)
    if not items:
        return False, "没有产出任何风险项"

    known = _context_numbers(ctx)
    with_number = [
        i for i in items
        if any(_norm_number(n) in known for n in _MEANINGFUL_NUMBER.findall(str(i.get("evidence", ""))))
    ]
    need = (len(items) + 1) // 2
    if len(with_number) < need:
        empty = "、".join(str(i.get("name", "?")) for i in items if i not in with_number)
        return False, f"{len(items)} 条里只有 {len(with_number)} 条引用了具体数值（至少要 {need} 条）；空泛的：{empty}"
    return True, ""


def check_risk_item_count(low: int, high: int) -> Callable:
    """条数落在区间内。太少是漏评，太多是把噪音也塞进来，医生一条都不会看。"""

    def _check(data: dict, ctx: dict) -> tuple[bool, str]:
        n = len(_risk_items(data))
        if low <= n <= high:
            return True, ""
        return False, f"产出 {n} 条风险项，要求 {low}–{high} 条"

    return _check


def check_risk_fields_filled(data: dict, ctx: dict) -> tuple[bool, str]:
    """
    五个字段都不能是空壳。

    Schema 只保证键在，不保证有内容 —— `"suggestion": ""` 是合法 JSON，
    但界面上就是一条没有建议的风险，医生看了不知道要做什么。
    """
    missing: list[str] = []
    for item in _risk_items(data):
        for field in ("name", "level", "evidence", "assessment", "suggestion"):
            if not str(item.get(field, "")).strip():
                missing.append(f"{item.get('name', '?')}.{field}")
    if missing:
        return False, f"这些字段是空的：{'、'.join(missing[:6])}"
    return True, ""


CHECK_REGISTRY.update(
    {
        "risk_evidence_grounded": lambda args: check_risk_evidence_grounded,
        "risk_evidence_quantified": lambda args: check_risk_evidence_quantified,
        "risk_item_count": lambda args: check_risk_item_count(int(args["low"]), int(args["high"])),
        "risk_fields_filled": lambda args: check_risk_fields_filled,
    }
)
