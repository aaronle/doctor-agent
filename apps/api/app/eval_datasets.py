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


def load_datasets() -> list[EvalDataset]:
    """
    读盘并编译全部数据集。按文件名排序，保证列表顺序稳定。

    每次调用都重读文件 —— 数据集只有几 KB，换来的是「改完 JSON 刷新即生效」，
    不必重启服务。
    """
    out: list[EvalDataset] = []
    if not DATASET_DIR.exists():
        return out
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
    return out


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
    datasets = load_datasets()
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
    datasets = load_datasets()
    on = enabled_map(session, datasets)
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
        }
        for d in datasets
    ]


def universal_checks() -> list[tuple[str, Callable]]:
    """所有岗位都要过的红线检查。不随数据集开关变化。"""
    return list(UNIVERSAL_CHECKS)
