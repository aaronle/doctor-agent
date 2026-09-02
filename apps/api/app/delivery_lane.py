"""
把控制台里跑的一次回归，写进交付平台的**智能体线**。

放在这里而不是 `routers/delivery.py`，是为了避免 router 之间互相 import ——
两个路由模块一旦成环，之后谁都不敢再动它们的 import 顺序。

进程内直接写库，不绕 `/api/delivery/runs` 那条上报接口。那条接口要令牌，
是因为它从公网进来；同一个进程里再发一次 HTTP、再配一次令牌，
只会多一个能配错的地方。
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import DeliveryRun
from .obs import event

#: 智能体线的阶段。与 `routers/delivery.py` 的 STAGE_TEMPLATES["agent"] 对齐。
#: 两处都要用同一串名字，否则界面会把同一个阶段画成两个。
STAGES = ("改动", "装配自检", "并排对比", "回归集", "发布")


def _failed_reason(row: dict) -> str:
    """
    从失败的用例里提出**为什么算失败**。

    智能体的失败不自明 —— 「回归集 10/13」这四个字拿不去改任何东西。
    界面上要的是「哪一条检查没过、检查说了什么」。
    """
    bad = [c for c in row.get("checks", []) if not c.get("passed")]
    if not bad:
        return "用例判定为未通过，但没有具体到某一条检查 —— 这本身是校验规则的问题"
    return "；".join(f"{c['name']}：{c.get('detail') or '无说明'}" for c in bad[:3])


def record_agent_lane_run(
    session: Session,
    *,
    agent_key: str,
    label: str,
    use: str,
    config_version: str,
    rows: list[dict],
    datasets: list[dict],
) -> DeliveryRun:
    total = len(rows)
    passed = sum(1 for r in rows if r.get("passed"))
    failed_rows = [r for r in rows if not r.get("passed")]
    degraded = sum(1 for r in rows if r.get("degraded"))

    # 同一个岗位的同一档配置，重复跑就是更新同一条运行 ——
    # 每跑一次多一条，看板上永远只看得见最后一次，前面那些纯属占地方。
    run_key = f"agent-{agent_key}-{use}"
    run = session.scalars(select(DeliveryRun).where(DeliveryRun.run_key == run_key)).first()
    if run is None:
        run = DeliveryRun(run_key=run_key, lane="agent", started_at=datetime.now(UTC))
        session.add(run)

    all_passed = total > 0 and passed == total
    gate_status = "passed" if all_passed else "failed"

    run.title = f"{label} · {'草稿' if use == 'draft' else '线上配置'} {config_version}"
    run.subtitle = (
        f"数据集 {'、'.join(d['name'] for d in datasets) or '无'}"
        + (f" · {degraded} 条降级" if degraded else "")
    )
    run.status = "passed" if all_passed else "blocked"
    run.stages = [
        {
            "name": "改动",
            "status": "passed" if use == "draft" else "skipped",
            "detail": "草稿" if use == "draft" else "跑的是线上配置，没有改动",
            "elapsed_ms": 0,
        },
        {"name": "装配自检", "status": "passed", "detail": f"配置 {config_version}", "elapsed_ms": 0},
        # 并排对比是控制台里另一个动作，这次回归不知道它跑没跑 ——
        # 不知道就报 idle，别替它填一个「通过」。
        {"name": "并排对比", "status": "idle", "detail": "", "elapsed_ms": 0},
        {
            "name": "回归集",
            "status": gate_status,
            # 通过率必须带分母：13 条的 77% 和 130 条的 77% 是两回事
            "detail": f"{passed}/{total}",
            "elapsed_ms": sum(int(r.get("elapsed_ms") or 0) for r in rows),
        },
        {
            "name": "发布",
            "status": "idle",
            "detail": "" if all_passed else "回归未过，发布已锁",
            "elapsed_ms": 0,
        },
    ]
    run.meta = {
        **(run.meta or {}),
        "agent_key": agent_key,
        "use": use,
        "config_version": config_version,
        "pass_rate": {"passed": passed, "total": total},
        "degraded_cases": degraded,
        "datasets": [d["id"] for d in datasets],
        "regressions": [
            {"case": r.get("name") or r.get("case_id", ""), "reason": _failed_reason(r)}
            for r in failed_rows
        ],
    }
    run.updated_at = datetime.now(UTC)

    session.commit()
    event("delivery_agent_lane", agent=agent_key, use=use, passed=passed, total=total)
    return run
