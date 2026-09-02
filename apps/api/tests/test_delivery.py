"""
交付平台接口。

盯三类东西：
  - **权限边界**：读公开、写要令牌。这是这批接口唯一的安全面。
  - **两个真相**：智能体发布历史必须来自 agent_versions，不得另存一份。
  - **生产指纹读运行时值**：它存在的全部意义就是发现「代码说 A、生产在跑 B」。
"""

from __future__ import annotations

import os

import pytest

TOKEN = "test-ingest-token"


@pytest.fixture()
def ingest(monkeypatch):
    monkeypatch.setenv("DELIVERY_INGEST_TOKEN", TOKEN)
    return {"X-Delivery-Token": TOKEN}


# ---------------------------------------------------------------- 权限边界


def test_reads_are_public_writes_need_token(client, ingest):
    """读接口与 /admin 同口径（演示期公开），写接口必须带令牌。"""
    for path in ("/api/delivery/pipelines", "/api/delivery/releases", "/api/delivery/production"):
        assert client.get(path).status_code == 200, path

    r = client.post("/api/delivery/runs", json={"run_key": "k1", "lane": "feature"})
    assert r.status_code == 401


def test_write_channel_is_closed_when_token_unset(client, monkeypatch):
    """
    没配令牌就**关闭写入通道**，不是放行。

    这个服务在公网上。默认放行意味着任何人都能往发布历史里塞记录 ——
    而「历史被污染」这种问题发现得越晚越难收拾。
    """
    monkeypatch.delenv("DELIVERY_INGEST_TOKEN", raising=False)
    r = client.post(
        "/api/delivery/runs",
        json={"run_key": "k-closed", "lane": "feature"},
        headers={"X-Delivery-Token": "anything"},
    )
    assert r.status_code == 503
    assert "写入通道" in r.json()["detail"]
    # 读不受影响，演示照常
    assert client.get("/api/delivery/pipelines").status_code == 200


# ---------------------------------------------------------------- 上报


def test_same_run_key_updates_instead_of_appending(client, ingest):
    """部署脚本会分多次上报同一次运行，每次带完整快照。重复上报必须是更新。"""
    body = {
        "run_key": "commit-abc123",
        "lane": "feature",
        "title": "abc123 换模型",
        "status": "running",
        "stages": [{"name": "改动", "status": "passed", "detail": "9 个文件"}],
    }
    assert client.post("/api/delivery/runs", json=body, headers=ingest).status_code == 200

    body["status"] = "deployed"
    body["stages"].append({"name": "部署", "status": "passed", "detail": "6m12s"})
    r = client.post("/api/delivery/runs", json=body, headers=ingest)
    assert r.status_code == 200
    assert r.json()["status"] == "deployed"

    listed = client.get("/api/delivery/runs?lane=feature").json()["items"]
    assert [i["run_key"] for i in listed].count("commit-abc123") == 1


def test_run_key_cannot_switch_lanes(client, ingest):
    """
    同一个 key 换条线 = 上报方的 key 生成规则撞了。

    静默覆盖会让两条线的历史混在一起，之后再也分不开 —— 必须当场报错。
    """
    body = {"run_key": "dup-key", "lane": "feature"}
    assert client.post("/api/delivery/runs", json=body, headers=ingest).status_code == 200
    r = client.post("/api/delivery/runs", json={"run_key": "dup-key", "lane": "agent"}, headers=ingest)
    assert r.status_code == 409


def test_unreported_stages_are_filled_from_template(client, ingest):
    """
    只报了一个阶段的流水线，界面上仍要看得出后面还有几关。

    否则一条刚开始的运行看起来「只有一个阶段且已通过」，像是已经做完了。
    """
    client.post(
        "/api/delivery/runs",
        json={
            "run_key": "just-started",
            "lane": "feature",
            "stages": [{"name": "改动", "status": "passed"}],
        },
        headers=ingest,
    )
    stages = client.get("/api/delivery/runs/just-started").json()["stages"]
    names = [s["name"] for s in stages]
    assert names[0] == "改动" and stages[0]["status"] == "passed"
    assert "部署" in names
    assert all(s["status"] == "idle" for s in stages[1:])


def test_agent_lane_has_its_own_stage_template(client, ingest):
    """两条线不共用阶段模板 —— 智能体线没有「构建」，功能线没有「回归集」。"""
    client.post("/api/delivery/runs", json={"run_key": "a1", "lane": "agent"}, headers=ingest)
    names = [s["name"] for s in client.get("/api/delivery/runs/a1").json()["stages"]]
    assert "回归集" in names and "构建" not in names


def test_lane_filter_rejects_unknown_lane(client):
    assert client.get("/api/delivery/runs?lane=nope").status_code == 400


def test_pipelines_returns_latest_per_lane(client, ingest):
    for i in (1, 2):
        client.post(
            "/api/delivery/runs",
            json={"run_key": f"f{i}", "lane": "feature", "title": f"第 {i} 次"},
            headers=ingest,
        )
    data = client.get("/api/delivery/pipelines").json()
    assert data["lanes"]["feature"]["title"] == "第 2 次"
    # 部署执行方必须在数据里说清楚，不写死在前端
    assert data["deploy_executor"] == "local"


# ---------------------------------------------------------------- 发布与回滚


def test_new_release_supersedes_the_previous_one(client, ingest):
    client.post("/api/delivery/releases", json={"commit": "aaa1111", "title": "第一版"}, headers=ingest)
    client.post("/api/delivery/releases", json={"commit": "bbb2222", "title": "第二版"}, headers=ingest)

    items = [i for i in client.get("/api/delivery/releases").json()["items"] if i["kind"] == "feature"]
    by_ref = {i["ref"]: i for i in items}
    assert by_ref["bbb2222"]["status"] == "current"
    assert by_ref["aaa1111"]["status"] == "superseded"


def test_release_is_audited_in_the_same_transaction(client, ingest):
    """
    审计与业务写入同生共死。

    先 commit 再记审计，中间挂掉就会留下一条没有审计的发布记录 ——
    一期真踩过一次（数据集开关），这里用 flush + 单次 commit 兜住。
    """
    client.post("/api/delivery/releases", json={"commit": "ccc3333", "title": "带审计"}, headers=ingest)
    logs = client.get("/api/admin/runs").status_code  # 端点存在即可
    assert logs in (200, 404)

    from app.database import SessionLocal
    from app.models import AuditLog

    with SessionLocal() as s:
        rows = [a for a in s.query(AuditLog).all() if a.action == "delivery_release"]
    assert any(a.detail.get("commit") == "ccc3333" for a in rows)


def test_cannot_roll_back_to_the_version_already_in_production(client, ingest):
    client.post("/api/delivery/releases", json={"commit": "ddd4444"}, headers=ingest)
    r = client.post("/api/delivery/releases/feature/ddd4444/rollback", headers=ingest)
    assert r.status_code == 409


def test_feature_rollback_reports_that_it_did_not_execute(client, ingest):
    """
    平台不持有生产凭据，所以功能回滚**没有真的执行**。

    接口必须把这一点写在返回里（`executed: False` + 要跑的命令），
    否则界面上「点了回滚」会被当成「回滚了」。
    """
    client.post("/api/delivery/releases", json={"commit": "eee5555"}, headers=ingest)
    client.post("/api/delivery/releases", json={"commit": "fff6666"}, headers=ingest)

    r = client.post("/api/delivery/releases/feature/eee5555/rollback", headers=ingest)
    assert r.status_code == 200
    body = r.json()
    assert body["executed"] is False
    assert "凭据" in body["reason"]
    assert "docker compose" in body["command"]


def test_rollback_of_unknown_commit_is_404(client, ingest):
    assert client.post("/api/delivery/releases/feature/nope/rollback", headers=ingest).status_code == 404


def test_agent_releases_come_from_agent_versions_not_a_copy(client, ingest):
    """
    智能体发布历史必须**读 agent_versions**，不得在交付平台另存一份。

    存两份就会有两个真相，而回滚只改得动其中一个 —— 复制过来的那份必然过期。
    这里用控制台真发布一版，然后要求它出现在交付平台的时间线上。
    """
    client.put(
        "/api/admin/agents/risk/draft",
        json={"model_tier": "clinical_fast", "role_prompt": "测试用草稿", "params": {}},
    )
    pub = client.post("/api/admin/agents/risk/publish")
    assert pub.status_code == 200

    items = client.get("/api/delivery/releases").json()["items"]
    agent_items = [i for i in items if i["kind"] == "agent"]
    assert agent_items, "控制台发布过的版本必须出现在交付平台的时间线上"
    assert any(i["meta"]["agent_key"] == "risk" for i in agent_items)
    # 当前版不可回滚到自己
    current = [i for i in agent_items if i["status"] == "current"]
    assert all(not i["can_rollback"] for i in current)


def test_release_timeline_mixes_both_kinds_in_time_order(client, ingest):
    """两种制品同一条时间线 —— 分成两个页签就等于把「谁先动的」这个问题藏起来。"""
    data = client.get("/api/delivery/releases").json()
    kinds = {i["kind"] for i in data["items"]}
    assert kinds == {"feature", "agent"}
    ats = [i["at"] or "" for i in data["items"]]
    assert ats == sorted(ats, reverse=True)
    assert "不重启" in data["rollback_semantics"]["agent"]


# ---------------------------------------------------------------- 生产指纹


def test_production_reads_runtime_model_not_code_default(client, monkeypatch):
    """
    生产指纹必须读**运行时解析后**的模型，不读代码缺省。

    2026-09-02 真踩过：代码缺省改成了 Sonnet，服务器 env 还压着 Haiku，
    产品路径六个岗位一直在跑 Haiku。这个接口存在的意义就是让这种事一眼看见。
    """
    from app import config

    monkeypatch.setenv("AI_FAST_MODEL", "some-other-model")
    config.get_ai_settings.cache_clear()
    try:
        body = client.get("/api/delivery/production").json()
        assert body["from_image"]["model_fast"] == "some-other-model"
    finally:
        config.get_ai_settings.cache_clear()


def test_production_separates_image_side_from_database_side(client):
    """
    镜像 tag 只说明了一半：智能体版本不在镜像里，光看提交号看不出跑的是哪版 prompt。
    """
    body = client.get("/api/delivery/production").json()
    assert set(body) >= {"from_image", "from_database", "note"}
    assert {"model_fast", "model_orchestration", "release"} <= set(body["from_image"])

    agents = body["from_database"]["agents"]
    assert len(agents) == 6
    # 没有 published 记录的岗位要标明它吃的是代码兜底，而不是假装有版本
    assert all(a["source"] in ("database", "code_default") for a in agents)


# ---------------------------------------------------------------- 智能体线自动落库


def test_console_eval_lands_on_the_agent_lane(client):
    """
    控制台跑一次回归，交付平台的智能体线就应该有东西 ——
    **不需要额外操作、不需要令牌**（同进程写库，不走公网上报接口）。

    否则「智能体线」永远是空的，因为没人会为了看板专门再跑一次。
    """
    r = client.post("/api/admin/agents/record/eval", json={"use": "published"})
    assert r.status_code == 200
    total = r.json()["total"]

    lane = client.get("/api/delivery/pipelines").json()["lanes"]["agent"]
    assert lane is not None
    assert lane["meta"]["pass_rate"]["total"] == total
    assert lane["meta"]["agent_key"] == "record"


def test_agent_lane_reports_why_each_case_failed(client):
    """
    「回归集 10/13」这四个字拿不去改任何东西。
    未通过的条目必须带上是哪一条检查没过、检查说了什么。
    """
    client.post("/api/admin/agents/record/eval", json={"use": "published"})
    lane = client.get("/api/delivery/pipelines").json()["lanes"]["agent"]
    rate = lane["meta"]["pass_rate"]
    regressions = lane["meta"]["regressions"]
    assert len(regressions) == rate["total"] - rate["passed"]
    for item in regressions:
        assert item["case"] and item["reason"]


def test_agent_lane_does_not_claim_a_comparison_it_never_ran(client):
    """
    并排对比是控制台里另一个动作，这次回归不知道它跑没跑。
    不知道就报 idle —— 替它填一个「通过」，就是在编。
    """
    client.post("/api/admin/agents/record/eval", json={"use": "published"})
    lane = client.get("/api/delivery/pipelines").json()["lanes"]["agent"]
    compare = next(s for s in lane["stages"] if s["name"] == "并排对比")
    assert compare["status"] == "idle"


def test_repeated_eval_updates_the_same_lane_run(client):
    """同一岗位同一档配置重复跑是更新，不是每次多一条 —— 否则看板下面全是历史垃圾。"""
    for _ in range(2):
        client.post("/api/admin/agents/record/eval", json={"use": "published"})
    runs = client.get("/api/delivery/runs?lane=agent").json()["items"]
    keys = [r["run_key"] for r in runs]
    assert keys.count("agent-record-published") == 1


def test_eval_still_returns_even_if_the_lane_write_blows_up(client, monkeypatch):
    """
    交付平台写失败不能影响回归结果 —— 人是来看通过率的，不是来看看板的。
    """
    from app.routers import admin as admin_router

    def boom(*_a, **_kw):
        raise RuntimeError("模拟写库失败")

    monkeypatch.setattr(admin_router, "record_agent_lane_run", boom)
    r = client.post("/api/admin/agents/record/eval", json={"use": "published"})
    assert r.status_code == 200
    assert "total" in r.json()


def test_two_reporters_do_not_erase_each_others_stages(client, ingest):
    """
    同一次运行有两个上报方：verify.mjs 报门禁，deploy.mjs 报部署。谁都不知道对方报过什么。

    整体替换的结果是后跑的把先跑的抹掉 —— 实测过一次：部署完成后再跑门禁，
    看板上的「部署」变回了未开始。按阶段名合并才符合「各人只对自己那几个阶段负责」。
    """
    key = "merge-me"
    client.post(
        "/api/delivery/runs",
        json={"run_key": key, "lane": "feature", "status": "deployed",
              "stages": [{"name": "部署", "status": "passed", "detail": "公网复验全绿"}]},
        headers=ingest,
    )
    client.post(
        "/api/delivery/runs",
        json={"run_key": key, "lane": "feature", "status": "passed",
              "stages": [{"name": "构建", "status": "passed", "detail": "dist 1.67 MB"}]},
        headers=ingest,
    )
    stages = {s["name"]: s for s in client.get(f"/api/delivery/runs/{key}").json()["stages"]}
    assert stages["部署"]["status"] == "passed", "部署阶段被后一次上报抹掉了"
    assert stages["构建"]["detail"] == "dist 1.67 MB"


def test_same_reporter_overwrites_its_own_stage(client, ingest):
    """合并是按名字覆盖，不是追加 —— 同一个阶段重复上报只保留最新一次。"""
    key = "overwrite-me"
    for detail in ("rsync", "docker build"):
        client.post(
            "/api/delivery/runs",
            json={"run_key": key, "lane": "feature",
                  "stages": [{"name": "部署", "status": "running", "detail": detail}]},
            headers=ingest,
        )
    stages = [s for s in client.get(f"/api/delivery/runs/{key}").json()["stages"] if s["name"] == "部署"]
    assert len(stages) == 1
    assert stages[0]["detail"] == "docker build"


def test_redeploying_the_same_commit_updates_one_record(client, ingest):
    """
    工作区没提交干净时会连着发两次同一个 commit。插两条的后果是**回滚变成抛硬币** ——
    `rollback_feature` 按 commit 查，`.first()` 拿到哪一条全看运气，
    而两条的状态可能一个 current 一个 superseded。
    """
    for detail in ("第一次", "第二次"):
        client.post(
            "/api/delivery/releases",
            json={"commit": "same111", "title": "同一版", "detail": detail},
            headers=ingest,
        )
    rows = [i for i in client.get("/api/delivery/releases").json()["items"]
            if i["kind"] == "feature" and i["ref"] == "same111"]
    assert len(rows) == 1
    assert rows[0]["detail"] == "第二次"
    assert rows[0]["status"] == "current"


def test_rollback_target_is_unambiguous_after_a_redeploy(client, ingest):
    """重发同一版之后，回滚到上一版仍然指向唯一的一条记录。"""
    client.post("/api/delivery/releases", json={"commit": "old999", "title": "旧版"}, headers=ingest)
    for _ in range(2):
        client.post("/api/delivery/releases", json={"commit": "new888", "title": "新版"}, headers=ingest)

    r = client.post("/api/delivery/releases/feature/old999/rollback", headers=ingest)
    assert r.status_code == 200

    items = {i["ref"]: i for i in client.get("/api/delivery/releases").json()["items"] if i["kind"] == "feature"}
    assert items["old999"]["status"] == "current"
    assert items["new888"]["status"] == "rolled_back"


def test_existing_duplicates_are_collapsed_on_next_release(client, ingest):
    """
    加了「同 commit 只留一条」的规则，不等于库里已有的重复行就消失了。
    下一次发布这个 commit 时要顺手收掉它们，否则回滚照样二选一。
    """
    from app.database import SessionLocal
    from app.models import FeatureRelease

    with SessionLocal() as s:
        for _ in range(3):
            s.add(FeatureRelease(commit="dupdup", title="历史重复行", status="superseded"))
        s.commit()

    client.post("/api/delivery/releases", json={"commit": "dupdup", "title": "重发"}, headers=ingest)

    with SessionLocal() as s:
        rows = s.query(FeatureRelease).filter(FeatureRelease.commit == "dupdup").all()
    assert len(rows) == 1
    assert rows[0].status == "current"
