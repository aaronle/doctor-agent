"""
评测数据集：加载、启停、编译成可执行的用例。

**为什么把用例从代码搬成数据**：回归集会越加越多（规范倒推的、外部导入的、
针对某次事故补的），而它们的启停是运行期决定 —— 改一行 Python 再重启，
不是管理，是发版。

**为什么启停状态落库而不是写回 JSON**：数据文件应当是只读的事实，
「这次要不要跑」是环境状态。把开关写进文件，等于每次点一下开关就改一次源码。

**为什么不在 JSON 里写代码**：检查项以「kind + args」声明，由
`eval_cases.CHECK_REGISTRY` 映射到函数。数据集将来可能来自外部导入，
不能给数据文件开执行入口。不认识的 kind 会**加载失败并报出来**，不静默跳过 ——
静默跳过会让一条本该跑的检查悄悄消失，而报告上看起来一切正常。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .eval_cases import UNIVERSAL_CHECKS, build_check
from .models import EvalDatasetState

DATASET_DIR = Path(__file__).resolve().parent / "data" / "eval_datasets"


@dataclass
class EvalCase:
    id: str
    name: str
    agent_key: str
    patient_id: str
    dataset_id: str
    dataset_name: str
    checks: list[tuple[str, Callable]] = field(default_factory=list)

    #: 传给 `agent.run()` 的额外入参。
    #:
    #: 吃 kwargs 的岗位（追问覆盖判定的 pending/conversation、问诊小结的
    #: conversation_summary、病历单段续写的段名）在此之前**一条用例都进不了
    #: 回归集** —— 跑器只传 ctx，它们拿到空参数，跑出来的是空壳输出，
    #: 校验还全绿。缺口不在某条用例上，在跑器上。
    kwargs: dict = field(default_factory=dict)

    #: 合并进 ctx 的额外字段。
    #:
    #: 有些输入按性质属于**上下文**而不是请求参数（追问覆盖判定要看的那段
    #: 对话就是），把它放进 ctx 才能让 `validate()` 够得着 ——
    #: 「引用必须出自对话」这条硬约束就是这样从评测搬回岗位里的。
    ctx_extra: dict = field(default_factory=dict)


@dataclass
class EvalDataset:
    id: str
    name: str
    description: str
    source: str
    reference: str
    default_enabled: bool
    cases: list[EvalCase]
    #  加载出错时不静默丢弃：数据集照样列出来，但带着错误，且不参与运行
    error: str = ""


def _compile(raw: dict, path: Path) -> EvalDataset:
    dataset_id = str(raw.get("id") or path.stem)
    dataset_name = str(raw.get("name") or dataset_id)
    cases: list[EvalCase] = []
    error = ""
    try:
        for case in raw.get("cases") or []:
            cases.append(
                EvalCase(
                    id=str(case["id"]),
                    name=str(case.get("name") or case["id"]),
                    agent_key=str(case["agent_key"]),
                    patient_id=str(case["patient_id"]),
                    dataset_id=dataset_id,
                    dataset_name=dataset_name,
                    checks=[build_check(c) for c in case.get("checks") or []],
                    kwargs=dict(case.get("kwargs") or {}),
                    ctx_extra=dict(case.get("ctx_extra") or {}),
                )
            )
    except Exception as exc:
        # 编译失败的数据集整体作废：跑一半的用例给出的通过率是误导性的
        cases = []
        error = f"{type(exc).__name__}: {exc}"

    return EvalDataset(
        id=dataset_id,
        name=dataset_name,
        description=str(raw.get("description") or ""),
        source=str(raw.get("source") or ""),
        reference=str(raw.get("reference") or ""),
        default_enabled=bool(raw.get("default_enabled", True)),
        cases=cases,
        error=error,
    )


#: 内置数据集的 id 集合。读一次文件目录得出，用来在界面上区分「内置 / 上传」——
#: 内置的删不掉（删了下次部署又回来），只能停用。
def builtin_ids() -> set[str]:
    if not DATASET_DIR.exists():
        return set()
    return {p.stem for p in DATASET_DIR.glob("*.json")}


def load_datasets(session: Session | None = None) -> list[EvalDataset]:
    """
    编译全部数据集 = **镜像里的文件** + **库里上传的**。

    每次调用都重读 —— 数据集只有几 KB，换来的是「改完刷新即生效」，不必重启。

    同 id 时**以库为准**：容器是 `read_only: true`，上传的东西只能进库，
    那它就得有能力覆盖内置的同名项，否则「上传一版改好的」这件事做不到。

    `session` 可省，省略时只出内置的 —— 有些调用点（离线脚本、纯文件校验）
    本来就不该碰库。
    """
    out: list[EvalDataset] = []
    if DATASET_DIR.exists():
        for path in sorted(DATASET_DIR.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                out.append(
                    EvalDataset(
                        id=path.stem, name=path.stem, description="", source="", reference="",
                        default_enabled=False, cases=[], error=f"文件解析失败：{exc}",
                    )
                )
                continue
            out.append(_compile(raw, path))

    if session is None:
        return out

    from .models import CustomEvalDataset

    by_id = {d.id: i for i, d in enumerate(out)}
    for row in session.scalars(select(CustomEvalDataset).order_by(CustomEvalDataset.dataset_id)).all():
        raw = dict(row.payload or {})
        raw.setdefault("id", row.dataset_id)
        compiled = _compile(raw, DATASET_DIR / f"{row.dataset_id}.json")
        if row.dataset_id in by_id:
            out[by_id[row.dataset_id]] = compiled     # 同 id 以库为准
        else:
            out.append(compiled)
    return out


def validate_payload(raw: object) -> list[str]:
    """
    上传前校验，返回**逐条**问题；空列表 = 可以入库。

    **不半吞半吐地存一半进去** —— 半个数据集给出的通过率是误导性的，
    而通过率正是这张表存在的理由。所以这里是「全对才收」。

    错误信息要指到具体位置（`cases[2].checks[0].kind`），不能只说
    「格式不对」：上传的人手里是一个几百行的 JSON，光说不对等于没说。
    """
    from .eval_cases import CHECK_REGISTRY

    errs: list[str] = []
    if not isinstance(raw, dict):
        return ["顶层必须是一个 JSON 对象"]
    if not str(raw.get("id") or "").strip():
        errs.append("缺 id")
    cases = raw.get("cases")
    if not isinstance(cases, list) or not cases:
        return errs + ["cases 必须是非空数组"]

    for i, case in enumerate(cases):
        at = f"cases[{i}]"
        if not isinstance(case, dict):
            errs.append(f"{at} 必须是对象")
            continue
        for field in ("id", "agent_key", "patient_id"):
            if not str(case.get(field) or "").strip():
                errs.append(f"{at} 缺 {field}")
        for j, chk in enumerate(case.get("checks") or []):
            cat = f"{at}.checks[{j}]"
            if not isinstance(chk, dict):
                errs.append(f"{cat} 必须是对象")
                continue
            kind = str(chk.get("kind") or "")
            if kind not in CHECK_REGISTRY:
                near = [k for k in CHECK_REGISTRY if kind and (kind in k or k in kind)]
                hint = f"（是不是想写 {near[0]}？）" if near else ""
                errs.append(f'{cat}.kind = "{kind}" —— 检查项不存在{hint}')
                continue
            # 参数不对也要当场发现：编译期抛错好过跑评测时才炸
            try:
                build_check(chk)
            except Exception as exc:
                errs.append(f"{cat} 参数不合法：{exc}")
    return errs


def enabled_map(session: Session, datasets: list[EvalDataset]) -> dict[str, bool]:
    """
    每个数据集当前启用与否。库里没有记录就取文件里的 default_enabled ——
    新增一个数据集不需要先写一条状态记录。
    """
    rows = {r.dataset_id: r.enabled for r in session.query(EvalDatasetState).all()}
    return {d.id: rows.get(d.id, d.default_enabled) for d in datasets}


def set_enabled(session: Session, dataset_id: str, enabled: bool) -> None:
    """
    改开关，**不提交** —— 由调用方连同审计一起提交。

    最初这里自己 commit，结果是开关先落库、随后 `record_audit` 的 add 无人提交，
    审计静默丢失：开关变了却查不到是谁什么时候改的。开关与留痕必须同一个事务。
    """
    row = session.get(EvalDatasetState, dataset_id)
    if row is None:
        session.add(EvalDatasetState(dataset_id=dataset_id, enabled=enabled))
    else:
        row.enabled = enabled
    session.flush()


def active_cases(session: Session, agent_key: str = "") -> list[EvalCase]:
    """
    要跑的用例：来自**已启用且无加载错误**的数据集，可再按岗位过滤。

    出错的数据集一律不跑。带着一个编译失败的数据集算通过率，
    分母就是错的，而报告上看不出来。
    """
    datasets = load_datasets(session)
    on = enabled_map(session, datasets)
    out: list[EvalCase] = []
    for ds in datasets:
        if ds.error or not on.get(ds.id):
            continue
        for case in ds.cases:
            if not agent_key or case.agent_key == agent_key:
                out.append(case)
    return out


def describe(session: Session) -> list[dict]:
    """给控制台看的数据集清单。"""
    datasets = load_datasets(session)
    on = enabled_map(session, datasets)
    builtin = builtin_ids()
    return [
        {
            "id": d.id,
            "name": d.name,
            "description": d.description,
            "source": d.source,
            "reference": d.reference,
            "enabled": bool(on.get(d.id)),
            "case_count": len(d.cases),
            "agents": sorted({c.agent_key for c in d.cases}),
            "error": d.error,
            # 内置的删不掉（删了下次部署又回来），界面据此隐藏删除按钮
            "builtin": d.id in builtin,
        }
        for d in datasets
    ]


def universal_checks() -> list[tuple[str, Callable]]:
    """所有岗位都要过的红线检查。不随数据集开关变化。"""
    return list(UNIVERSAL_CHECKS)
