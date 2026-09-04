"""数据看板：测试集与知识库的展示与维护。

一条硬约束贯穿全部：容器 `read_only: true`，上传的东西只能进库。
"""

import json


# ------------------------------------------------------------------ 测试集

VALID = {
    "id": "ortho-knee",
    "name": "骨科关节亚专科",
    "cases": [{
        "id": "OK-01", "name": "膝 OA 病历", "agent_key": "record", "patient_id": "P008",
        "checks": [{"name": "必填", "kind": "required_fields",
                    "args": {"fields": ["chief_complaint"]}}],
    }],
}


def test_upload_then_it_shows_up_merged_with_builtin(client):
    """上传的测试集与内置的在**同一张表**里出现，不是分两处。"""
    r = client.post("/api/data/datasets", json={"payload": VALID})
    assert r.status_code == 200, r.text
    assert r.json()["case_count"] == 1

    items = {d["id"]: d for d in client.get("/api/data/datasets").json()["items"]}
    assert "ortho-knee" in items
    assert items["ortho-knee"]["builtin"] is False
    assert items["builtin-regression"]["builtin"] is True


def test_bad_dataset_is_rejected_whole_not_half(client):
    """**全对才收。**

    半个数据集入库、另一半报错，使用者无从知道究竟进去了哪些 ——
    而通过率正是这张表存在的理由，分母不对整张报告就是误导。
    """
    bad = {
        "id": "broken",
        "cases": [
            {"id": "B-1", "agent_key": "record", "patient_id": "P001",
             "checks": [{"kind": "atomic_question", "args": {}}]},     # 少了 s
            {"id": "B-2", "agent_key": "record"},                       # 缺 patient_id
        ],
    }
    r = client.post("/api/data/datasets", json={"payload": bad})
    assert r.status_code == 422
    errs = r.json()["detail"]["errors"]
    # 错误要**指到位置**，不能只说「格式不对」—— 对方手里是几百行 JSON
    assert any("cases[0].checks[0].kind" in e for e in errs)
    assert any("atomic_questions" in e for e in errs), "近似项要给出提示"
    assert any("cases[1] 缺 patient_id" in e for e in errs)

    # 一条都不许进去
    assert "broken" not in {d["id"] for d in client.get("/api/data/datasets").json()["items"]}


def test_uploaded_dataset_actually_runs(client):
    """上传的用例要真的进「要跑的用例」，不能只在列表里好看。"""
    from app.database import SessionLocal
    from app.eval_datasets import active_cases

    client.post("/api/data/datasets", json={"payload": VALID})
    s = SessionLocal()
    try:
        ids = {c.id for c in active_cases(s, "record")}
        assert "OK-01" in ids
    finally:
        s.close()


def test_same_id_overrides_builtin(client):
    """同 id **以库为准** —— 否则「上传一版改好的内置集」这件事做不到。"""
    payload = {**VALID, "id": "builtin-regression", "name": "本院改过的回归集"}
    client.post("/api/data/datasets", json={"payload": payload})

    items = {d["id"]: d for d in client.get("/api/data/datasets").json()["items"]}
    assert items["builtin-regression"]["name"] == "本院改过的回归集"
    assert items["builtin-regression"]["case_count"] == 1
    # 列表里只出现一次，不是内置和上传各一行
    assert sum(1 for d in client.get("/api/data/datasets").json()["items"]
               if d["id"] == "builtin-regression") == 1
    client.delete("/api/data/datasets/builtin-regression")   # 还原，别污染别的用例


def test_builtin_cannot_be_deleted(client):
    """内置的删不掉 —— 文件在只读镜像里，删了下次部署又回来。"""
    r = client.delete("/api/data/datasets/followup-prompt")
    assert r.status_code == 400
    assert "停用" in r.json()["detail"], "要告诉对方正确的做法是关开关"


def test_delete_uploaded(client):
    client.post("/api/data/datasets", json={"payload": {**VALID, "id": "tmp-set"}})
    assert client.delete("/api/data/datasets/tmp-set").status_code == 200
    assert client.delete("/api/data/datasets/tmp-set").status_code == 404


# ------------------------------------------------------------------ 知识库


def test_knowledge_list_reports_body_length_not_body(client):
    """列表带**正文长度**不带正文，并数出空词条。

    > 设计稿里我写过「现有 7 条内置词条正文全是空的」——**那是错的**。
    > 我当时读的是 `body` 字段，而它实际叫 `content`，7 条都有 266–823 字。
    > 这条用例因此改成钉**机制**（空的能被数出来），不钉「当前恰好有几条空的」——
    > 拿当下的数据当断言，正是那次误判的根源。
    """
    body = client.get("/api/data/knowledge").json()
    assert all("content" not in i for i in body["items"]), "列表不该带正文"
    assert all(i["content_length"] > 0 for i in body["items"] if i["source"] == "builtin"), \
        "内置词条本来就都有正文"

    # 造一条真空的，验证它能被数出来
    client.put("/api/data/knowledge/blank_probe",
               json={"key": "blank_probe", "title": "空探针", "keywords": ["空"], "content": ""})
    after = client.get("/api/data/knowledge").json()
    assert after["empty_count"] >= 1
    assert next(i for i in after["items"] if i["key"] == "blank_probe")["content_length"] == 0
    client.delete("/api/data/knowledge/blank_probe")


def test_save_and_it_wins_over_builtin(client):
    client.put("/api/data/knowledge/blood_rt", json={
        "key": "blood_rt", "title": "血常规解读（本院版）",
        "keywords": ["血常规", "白细胞"], "content": "<p>本院口径</p>",
    })
    items = {i["key"]: i for i in client.get("/api/data/knowledge").json()["items"]}
    assert items["blood_rt"]["title"] == "血常规解读（本院版）"
    assert items["blood_rt"]["source"] == "local"
    assert items["blood_rt"]["content_length"] > 0


def test_builtin_entry_can_be_tombstoned(client):
    """内置词条**也能删** —— 真删不了文件，但可以在库里写墓碑，读取时跳过。

    医生说「这条不对，别再让模型查它」是合理诉求；只能删自己加的等于做不到。
    """
    before = {i["key"] for i in client.get("/api/data/knowledge").json()["items"]}
    assert "stool_rt" in before

    assert client.delete("/api/data/knowledge/stool_rt").status_code == 200
    after = {i["key"] for i in client.get("/api/data/knowledge").json()["items"]}
    assert "stool_rt" not in after

    # 再写回来要能生效 —— 覆盖会把墓碑一并抹掉
    client.put("/api/data/knowledge/stool_rt", json={
        "key": "stool_rt", "title": "大便常规解读", "keywords": ["大便常规"], "content": "<p>x</p>",
    })
    assert "stool_rt" in {i["key"] for i in client.get("/api/data/knowledge").json()["items"]}


def test_knowledge_content_is_sanitized(client):
    """**正文可编辑之后，v-html 就不再安全了。**

    原注释写着「正文由本仓库静态提供、无用户输入参与拼接，因此 v-html 安全」——
    那个前提在可上传可编辑之后不成立。而 /admin 目前无登录，
    等于给了任何人一个往医生浏览器里注入脚本的口子。
    """
    r = client.put("/api/data/knowledge/xss_probe", json={
        "key": "xss_probe", "title": "探针", "keywords": ["探针"],
        "content": '<script>alert(1)</script><p onclick="steal()">正文</p><img src=x onerror=alert(1)>',
    })
    assert r.status_code == 200
    assert r.json()["sanitized"] is True

    stored = client.get("/api/data/knowledge/xss_probe").json()["content"]

    # 判据是「**还有没有可执行的 HTML**」，不是「字符串里有没有 onerror 这几个字」。
    # `<img … onerror=…>` 被整体转义成 `&lt;img … onerror=…&gt;` 是安全的
    # 也是有意的 —— 转义而不删除，写的人才看得见自己那段被挡下了。
    import re
    executable = re.findall(r"<\s*/?\s*([a-zA-Z0-9]+)([^>]*)>", stored)
    assert all(tag.lower() in {"p", "br", "h3", "h4", "strong", "em", "b", "i", "u",
                               "code", "ul", "ol", "li", "table", "thead", "tbody",
                               "tr", "th", "td", "span", "div"} for tag, _ in executable), \
        f"有标签逃出了白名单：{executable}"
    assert not any(re.search(r"\bon\w+\s*=", attrs) for _, attrs in executable), \
        "白名单标签上还挂着事件处理器"
    assert "&lt;script&gt;" in stored, "script 应被转义留痕，而不是悄悄删掉"
    assert "<p>正文</p>" in stored, "白名单标签要原样留下，不能连正常排版一起铲掉"


def test_knowledge_import_all_or_nothing(client):
    """批量导入也是全对才收 —— 一半进去一半报错，没人知道进去了哪些。"""
    r = client.post("/api/data/knowledge/import", json={"entries": {
        "good": {"title": "好的", "keywords": ["a"], "content": "<p>x</p>"},
        "bad": {"title": "", "keywords": [], "content": ""},
    }})
    assert r.status_code == 422
    errs = r.json()["detail"]["errors"]
    assert any("缺 title" in e for e in errs)
    assert any("keywords" in e for e in errs)
    assert any("正文为空" in e for e in errs)

    assert "good" not in {i["key"] for i in client.get("/api/data/knowledge").json()["items"]}


def test_knowledge_import_ok(client):
    r = client.post("/api/data/knowledge/import", json={"entries": {
        "kl_grade": {"title": "K-L 分级", "keywords": ["K-L", "膝关节"],
                     "content": "<h3>分级</h3><ul><li>Ⅳ 级</li></ul>"},
    }})
    assert r.status_code == 200 and r.json()["imported"] == 1
    d = client.get("/api/data/knowledge/kl_grade").json()
    assert d["source"] == "local" and "<h3>分级</h3>" in d["content"]
