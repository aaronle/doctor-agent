"""
交付平台（CI/CD）。功能线与智能体线并排，共用同一个环境视图。

设计要点见 `docs/product/16-交付平台-CICD需求规格说明书.md`。这里只重复三条
落在代码上的：

1. **读写分离的权限口径。** 读接口与 `/admin` 同口径（演示期公开）；
   写接口（上报、发布记录、回滚）要 `DELIVERY_INGEST_TOKEN`。
   读一份构建状态和往公网服务里写一条发布记录，风险不是一个量级。
2. **智能体的发布历史不在这张表里。** 它就是 `agent_versions`
   的 published 记录。复制一份到 feature_releases 会立刻有两个真相，
   而回滚只改得动其中一个。这里在查询时合并，不在写入时复制。
3. **生产指纹读运行时解析后的值，不读代码缺省。**
   2026-09-02 真踩过：代码缺省改成了 Sonnet，服务器 env 还压着 Haiku，
   产品路径六个岗位一直在跑 Haiku。`/api/health` 一直如实报着，只是没人看。
   这个接口存在的意义就是把「没人看」变成「一眼看见」。
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import DEMO_ACTOR, record_audit
from ..config import get_ai_settings, get_settings
from ..database import get_session
from ..eval_datasets import describe as describe_datasets
from ..models import AgentVersion, DeliveryRun, FeatureRelease
from ..obs import event
from ..schemas import StrictIn

router = APIRouter(prefix="/api/delivery", tags=["delivery"])

LANES = ("feature", "agent")

#: 两条线的阶段模板。上报方可以只报其中几个阶段，界面按模板补齐未开始的部分 ——
#: 否则一条刚开始的流水线看起来只有一个阶段，看不出后面还要过几关。
STAGE_TEMPLATES: dict[str, tuple[str, ...]] = {
    "feature": ("改动", "类型与单测", "构建", "契约导出", "界面还原度", "类名覆盖率", "部署"),
    "agent": ("改动", "装配自检", "并排对比", "回归集", "发布"),
}

#: 岗位 key → 中文名。控制台已有一份，这里只取展示用的名字，不引入依赖。
AGENT_LABELS = {
    "summary": "病情概况",
    "record": "病历生成",
    "diagnosis": "鉴别诊断",
    "risk": "风险管理",
    "comorbidity": "共病管理",
    "interview": "问诊小结",
}


def require_ingest_token(x_delivery_token: str = Header(default="")) -> str:
    """
    上报与回滚的写入口令。

    未配置时**关闭写入通道**而不是放行：这个服务在公网上，一个开着的写接口
    意味着任何人都能往发布历史里塞记录。读接口不受影响，演示照常。
    """
    expected = os.environ.get("DELIVERY_INGEST_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="未配置 DELIVERY_INGEST_TOKEN，交付平台的写入通道已关闭（读取不受影响）",
        )
    if x_delivery_token != expected:
        raise HTTPException(status_code=401, detail="X-Delivery-Token 不正确")
    return x_delivery_token


def _fill_stages(lane: str, reported: list[dict]) -> list[dict]:
    """按模板补齐未开始的阶段，保持模板顺序；模板外的阶段追加在后面。"""
    by_name = {s.get("name"): s for s in reported if isinstance(s, dict)}
    out: list[dict] = []
    for name in STAGE_TEMPLATES.get(lane, ()):
        s = by_name.pop(name, None)
        out.append(s if s else {"name": name, "status": "idle", "detail": "", "elapsed_ms": 0})
    out.extend(by_name.values())
    return out


def _run_out(run: DeliveryRun) -> dict:
    return {
        "run_key": run.run_key,
        "lane": run.lane,
        "title": run.title,
        "subtitle": run.subtitle,
        "status": run.status,
        "stages": _fill_stages(run.lane, list(run.stages or [])),
        "meta": dict(run.meta or {}),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


# ---------------------------------------------------------------- 读


@router.get("/pipelines")
def pipelines(session: Session = Depends(get_session)) -> dict:
    """两条线各自最新的一次运行。看板的数据源。"""
    lanes = {}
    for lane in LANES:
        run = session.scalars(
            select(DeliveryRun).where(DeliveryRun.lane == lane).order_by(DeliveryRun.id.desc())
        ).first()
        lanes[lane] = _run_out(run) if run else None
    return {
        "lanes": lanes,
        # 界面上要标出来：平台触发与观测，不持有生产凭据，部署仍在开发机上跑。
        # 这句话放在数据里而不是写死在前端，是因为它会随权限方案变。
        "deploy_executor": "local",
        "deploy_note": "平台负责触发与观测，不持有生产凭据；部署仍走开发机的 SSH + rsync + docker。",
    }


@router.get("/runs")
def list_runs(lane: str = "", limit: int = 20, session: Session = Depends(get_session)) -> dict:
    if lane and lane not in LANES:
        raise HTTPException(status_code=400, detail=f"lane 只能是 {'、'.join(LANES)}")
    stmt = select(DeliveryRun).order_by(DeliveryRun.id.desc()).limit(max(1, min(limit, 100)))
    if lane:
        stmt = stmt.where(DeliveryRun.lane == lane)
    return {"items": [_run_out(r) for r in session.scalars(stmt)]}


@router.get("/runs/{run_key}")
def get_run(run_key: str, session: Session = Depends(get_session)) -> dict:
    run = session.scalars(select(DeliveryRun).where(DeliveryRun.run_key == run_key)).first()
    if run is None:
        raise HTTPException(status_code=404, detail=f"无此运行：{run_key}")
    return _run_out(run)


@router.get("/releases")
def releases(limit: int = 30, session: Session = Depends(get_session)) -> dict:
    """
    两种制品**同一条时间线**。

    排查「什么时候开始不对的」时，最需要知道的恰恰是这两者谁先动的 ——
    分成两个页签就等于把这个问题藏起来。

    智能体侧直接读 `agent_versions`（published/inactive），不另存一份。
    """
    items: list[dict] = []

    for r in session.scalars(select(FeatureRelease).order_by(FeatureRelease.id.desc()).limit(limit)):
        items.append(
            {
                "kind": "feature",
                "ref": r.commit,
                "title": r.title,
                "detail": r.detail,
                "status": r.status,
                "at": r.released_at.isoformat() if r.released_at else None,
                # 功能制品的回滚要换镜像重建容器，平台没有凭据，只能给出命令
                "can_rollback": r.status == "superseded",
                "meta": dict(r.meta or {}),
            }
        )

    published = {
        v.agent_key
        for v in session.scalars(select(AgentVersion).where(AgentVersion.status == "published"))
    }
    stmt = (
        select(AgentVersion)
        .where(AgentVersion.published_at.is_not(None))
        .order_by(AgentVersion.published_at.desc())
        .limit(limit)
    )
    for v in session.scalars(stmt):
        current = v.status == "published"
        items.append(
            {
                "kind": "agent",
                "ref": str(v.id),
                "title": f"{AGENT_LABELS.get(v.agent_key, v.agent_key)} · 岗位层 Prompt {v.version}",
                "detail": v.note or f"模型档位 {v.model_tier}",
                "status": "current" if current else "superseded",
                "at": v.published_at.isoformat() if v.published_at else None,
                # 回到某个历史版本 = 把它重新置为 published，不重启、不换镜像
                "can_rollback": not current and v.agent_key in published,
                "meta": {"agent_key": v.agent_key, "version": v.version, "model_tier": v.model_tier},
            }
        )

    items.sort(key=lambda i: i["at"] or "", reverse=True)
    return {
        "items": items[:limit],
        "rollback_semantics": {
            "feature": "换镜像 tag 重建容器，几十秒，行为立刻回到那一版。平台不持有生产凭据，只给出命令。",
            "agent": "把某个历史版本重新置为 published，下一次调用即生效，不重启、不换镜像。",
        },
    }


@router.get("/production")
def production(session: Session = Depends(get_session)) -> dict:
    """
    生产上现在到底是哪一版。

    分两栏是有原因的：**镜像 tag 只说明了一半。** 智能体版本不在镜像里，
    是数据库里的 published 记录 —— 光看提交号看不出生产在跑哪版 prompt。

    模型一律读运行时解析后的值（`get_ai_settings()`），不读代码里的缺省。
    这两者会不一致，且不一致时代码是错的那一方 —— 服务器的 env 优先级更高。
    """
    ai = get_ai_settings()
    settings = get_settings()

    current = session.scalars(
        select(FeatureRelease).where(FeatureRelease.status == "current").order_by(FeatureRelease.id.desc())
    ).first()

    agents = []
    for key, label in AGENT_LABELS.items():
        v = session.scalars(
            select(AgentVersion)
            .where(AgentVersion.agent_key == key, AgentVersion.status == "published")
            .order_by(AgentVersion.id.desc())
        ).first()
        agents.append(
            {
                "agent_key": key,
                "label": label,
                "version": v.version if v else "—",
                "model_tier": v.model_tier if v else "—",
                "published_at": v.published_at.isoformat() if v and v.published_at else None,
                # 没有 published 记录说明这个岗位还在吃代码里的兜底配置
                "source": "database" if v else "code_default",
            }
        )

    # 走 describe 而不是直接数 eval_dataset_states 的行。
    #
    # 那张表只存**被人改过**的开关；没人动过的数据集根本没有行，
    # 于是「3 开 2 关」会显示成「0 开 0 关」—— 看着像一个数据集都没有，
    # 实际是全都在按文件里的 default_enabled 跑。生产指纹要报的是生效状态，
    # 不是「谁改过」。
    datasets = describe_datasets(session)
    return {
        "from_image": {
            "release": settings.release,
            "commit": (current.commit if current else ""),
            "image": (current.image if current else ""),
            "released_at": current.released_at.isoformat() if current and current.released_at else None,
            "runtime_mode": settings.runtime_mode,
            "write_back_mode": settings.write_back_mode,
            # 运行时真实生效的模型，不是代码缺省
            "model_fast": ai.fast_model,
            "model_smart": ai.smart_model,
            "model_orchestration": os.environ.get("AI_ORCHESTRATION_MODEL", "claude-sonnet-5"),
            "ai": "configured" if ai.configured else "unconfigured",
            "timeout_ms": ai.timeout_ms,
        },
        "from_database": {
            "agents": agents,
            "datasets_enabled": sum(1 for d in datasets if d["enabled"]),
            "datasets_disabled": sum(1 for d in datasets if not d["enabled"]),
        },
        "note": "镜像栏换镜像才会变；数据库栏不重启即可变。两栏都读生产本身，不是从发布记录推出来的。",
        "at": datetime.now(UTC).isoformat(),
    }


# ---------------------------------------------------------------- 写（需令牌）


class StageIn(StrictIn):
    name: str
    status: str = "idle"  # idle | running | passed | failed | skipped
    detail: str = ""
    elapsed_ms: int = 0
    note: str = ""


class RunIn(StrictIn):
    run_key: str
    lane: str
    title: str = ""
    subtitle: str = ""
    status: str = "running"
    stages: list[StageIn] = []
    meta: dict = {}


@router.post("/runs")
def upsert_run(
    body: RunIn,
    session: Session = Depends(get_session),
    _token: str = Depends(require_ingest_token),
) -> dict:
    """
    上报一次运行。**同 run_key 是更新而不是新增** —— 部署脚本会分多次上报同一次运行，
    每次带上到目前为止的完整阶段快照。
    """
    if body.lane not in LANES:
        raise HTTPException(status_code=400, detail=f"lane 只能是 {'、'.join(LANES)}")

    run = session.scalars(select(DeliveryRun).where(DeliveryRun.run_key == body.run_key)).first()
    if run is None:
        run = DeliveryRun(run_key=body.run_key, lane=body.lane, started_at=datetime.now(UTC))
        session.add(run)
    elif run.lane != body.lane:
        # 同一个 key 换了条线，说明上报方的 key 生成规则撞了。静默覆盖会让两条线的
        # 历史混在一起，之后再也分不开。
        raise HTTPException(
            status_code=409, detail=f"run_key {body.run_key} 已属于 {run.lane} 线，不能改成 {body.lane}"
        )

    run.title = body.title or run.title
    run.subtitle = body.subtitle or run.subtitle
    run.status = body.status
    if body.stages:
        # **按阶段名合并，不整体替换。**
        #
        # 同一次运行有两个上报方：`verify.mjs` 报门禁那几个阶段，`deploy.mjs` 报部署。
        # 谁都不知道对方报过什么。整体替换的结果是后跑的把先跑的抹掉 ——
        # 实测过一次：部署完成后再跑门禁，看板上的「部署」变回了未开始。
        #
        # 各报各的、按名字覆盖，才符合「每个上报方只对自己那几个阶段负责」。
        merged = {s.get("name"): s for s in (run.stages or []) if isinstance(s, dict)}
        for s in body.stages:
            merged[s.name] = s.model_dump()
        run.stages = list(merged.values())
    if body.meta:
        run.meta = {**(run.meta or {}), **body.meta}
    run.updated_at = datetime.now(UTC)

    session.commit()
    event("delivery_run", run_key=body.run_key, lane=body.lane, status=body.status)
    return _run_out(run)


class ReleaseIn(StrictIn):
    commit: str
    title: str = ""
    detail: str = ""
    image: str = ""
    meta: dict = {}


@router.post("/releases")
def record_release(
    body: ReleaseIn,
    session: Session = Depends(get_session),
    _token: str = Depends(require_ingest_token),
) -> dict:
    """记录一次功能发布，并把上一版置为 superseded。"""
    for old in session.scalars(select(FeatureRelease).where(FeatureRelease.status == "current")):
        old.status = "superseded"

    # **同一个提交只留一条。** 工作区没提交干净时会连着发两次同一个 commit，
    # 插两条的后果是回滚变成抛硬币 —— `rollback_feature` 按 commit 查，
    # `.first()` 拿到哪一条全看运气，而两条的状态可能一个 current 一个 superseded。
    # 重发同一版就是更新那一条，时间戳往后走。
    existing = list(
        session.scalars(
            select(FeatureRelease).where(FeatureRelease.commit == body.commit).order_by(FeatureRelease.id)
        )
    )
    if existing:
        rel = existing[0]
        # 顺手收掉之前已经插进去的重复行。加了唯一性约束不等于历史数据就干净了 ——
        # 库里那两条同 commit 的记录是这条规则生效前留下的，不清掉照样让回滚二选一。
        for dup in existing[1:]:
            session.delete(dup)
    else:
        rel = FeatureRelease(commit=body.commit)
        session.add(rel)

    rel.title = body.title
    rel.detail = body.detail
    rel.image = body.image
    rel.status = "current"
    rel.meta = body.meta
    rel.released_at = datetime.now(UTC)
    # flush 而不是 commit：审计与业务写入必须同生共死。
    # 先 commit 再记审计，中间挂掉就会留下一条没有审计的发布记录。
    session.flush()
    record_audit(
        session,
        actor=DEMO_ACTOR,
        action="delivery_release",
        entity="feature_release",
        entity_id=str(rel.id),
        detail={"commit": body.commit, "title": body.title},
    )
    session.commit()
    event("delivery_release", commit=body.commit)
    return {"id": rel.id, "commit": rel.commit, "status": rel.status}


@router.post("/releases/feature/{commit}/rollback")
def rollback_feature(
    commit: str,
    session: Session = Depends(get_session),
    _token: str = Depends(require_ingest_token),
) -> dict:
    """
    功能制品回滚。

    **平台不执行它。** 生产凭据在开发机上，这里只把状态改回去并返回要跑的命令 ——
    界面上必须如实说明这一点，否则「点了回滚」和「回滚了」会被当成一回事。
    """
    target = session.scalars(select(FeatureRelease).where(FeatureRelease.commit == commit)).first()
    if target is None:
        raise HTTPException(status_code=404, detail=f"无此发布记录：{commit}")
    if target.status == "current":
        raise HTTPException(status_code=409, detail="这一版就是当前生产，无需回滚")

    for old in session.scalars(select(FeatureRelease).where(FeatureRelease.status == "current")):
        old.status = "rolled_back"
    target.status = "current"
    session.flush()
    record_audit(
        session,
        actor=DEMO_ACTOR,
        action="delivery_rollback",
        entity="feature_release",
        entity_id=str(target.id),
        detail={"commit": commit},
    )
    session.commit()
    event("delivery_rollback", kind="feature", commit=commit)

    image = target.image or f"doctor-agent:{commit}"
    return {
        "commit": commit,
        "status": target.status,
        "executed": False,
        "reason": "平台不持有生产凭据，回滚需在开发机执行下列命令",
        "command": (
            f"ssh ubuntu@81.71.155.220 "
            f"\"cd /opt/doctor-agent/source && "
            f"docker compose -f deploy/tencent-guangzhou/docker-compose.yml "
            f"up -d --force-recreate doctor-agent\"  # image={image}"
        ),
    }
