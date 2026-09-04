"""
数据看板：测试集与知识库的展示与维护。

## 一条硬约束决定了这里的形状

容器是 `read_only: true`，只有 `/opt/doctor-agent/data` 这一个卷可写。
**上传的东西写进镜像里的文件，一次部署就没了。** 所以上传与编辑一律进库，
读取时与镜像里的内置项合并、同 id/key 以库为准。

顺带解释了两件界面上的事：内置项没有删除按钮（删不掉，删了下次部署又回来，
停用请用开关）；升级不丢本院内容（内置随版本更新，本院的在数据卷里）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import knowledge
from ..audit import record_audit
from ..database import get_session
from ..eval_datasets import builtin_ids, describe, validate_payload
from ..models import CustomEvalDataset, KnowledgeEntry
from ..schemas import StrictIn

router = APIRouter(prefix="/api/data", tags=["data-console"])


# ------------------------------------------------------------------ 测试集


class DatasetUploadIn(StrictIn):
    #: 原始 JSON。**存原始不存编译产物** —— 编译逻辑会跟着版本变，
    #: 存编译结果等于把今天的编译器固化进数据。
    payload: dict
    uploaded_by: str = ""


@router.get("/datasets")
def list_datasets(session: Session = Depends(get_session)) -> dict:
    return {"items": describe(session)}


@router.post("/datasets")
def upload_dataset(body: DatasetUploadIn, session: Session = Depends(get_session)) -> dict:
    """
    上传测试集。**全对才收。**

    半个数据集入库、另一半报错，使用者无从知道究竟进去了哪些 ——
    而通过率正是这张表存在的理由，分母不对整张报告就是误导。
    错误逐条指到位置（`cases[2].checks[0].kind`），不能只说「格式不对」。
    """
    errors = validate_payload(body.payload)
    if errors:
        # 422 而不是 400：这是内容语义不合法，不是请求本身坏了
        raise HTTPException(status_code=422, detail={"errors": errors})

    dataset_id = str(body.payload.get("id")).strip()
    row = session.get(CustomEvalDataset, dataset_id)
    created = row is None
    if row is None:
        row = CustomEvalDataset(dataset_id=dataset_id)
        session.add(row)
    row.name = str(body.payload.get("name") or dataset_id)
    row.payload = body.payload
    row.uploaded_by = body.uploaded_by

    record_audit(
        session, action="upload_eval_dataset", entity="custom_eval_dataset",
        entity_id=dataset_id,
        detail={"cases": len(body.payload.get("cases") or []), "created": created},
    )
    session.commit()
    return {"ok": True, "dataset_id": dataset_id, "created": created,
            "case_count": len(body.payload.get("cases") or [])}


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str, session: Session = Depends(get_session)) -> dict:
    """删除上传的测试集。**内置的删不掉** —— 文件在只读镜像里，删了下次部署又回来。"""
    if dataset_id in builtin_ids():
        raise HTTPException(status_code=400, detail="内置测试集不可删除，如需停用请关掉它的开关")
    row = session.get(CustomEvalDataset, dataset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="测试集不存在")
    session.delete(row)
    record_audit(session, action="delete_eval_dataset", entity="custom_eval_dataset",
                 entity_id=dataset_id, detail={})
    session.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 知识库


class KnowledgeIn(StrictIn):
    key: str
    title: str
    keywords: list[str] = Field(default_factory=list)
    content: str = ""


class KnowledgeImportIn(StrictIn):
    entries: dict


@router.get("/knowledge")
def list_knowledge(session: Session = Depends(get_session)) -> dict:
    """
    词条清单。**带 `content_length` 不带正文** —— 列表页不需要全文，
    而正文长度恰恰是这张表最有用的一列：现有内置词条正文全是空的，
    之前没有任何界面能看出这件事。
    """
    kb = knowledge.merged(session)
    items = [
        {
            "key": k,
            "title": v.get("title", ""),
            "keywords": v.get("keywords", []),
            "content_length": len(str(v.get("content") or "")),
            "source": v.get("source", "builtin"),
        }
        for k, v in sorted(kb.items())
    ]
    return {
        "items": items,
        "empty_count": sum(1 for i in items if i["content_length"] == 0),
    }


@router.get("/knowledge/{key}")
def get_knowledge(key: str, session: Session = Depends(get_session)) -> dict:
    kb = knowledge.merged(session)
    if key not in kb:
        raise HTTPException(status_code=404, detail="词条不存在")
    return {"key": key, **kb[key]}


@router.put("/knowledge/{key}")
def save_knowledge(key: str, body: KnowledgeIn, session: Session = Depends(get_session)) -> dict:
    """新增或覆盖一条词条。正文写入前消毒（见 `knowledge.sanitize`）。"""
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="标题不能为空")
    row = knowledge.upsert(session, key, body.title.strip(), body.keywords, body.content)
    record_audit(session, action="save_knowledge", entity="knowledge_entry",
                 entity_id=key, detail={"title": row.title, "length": len(row.content)})
    session.commit()
    return {"ok": True, "key": key, "content_length": len(row.content),
            "sanitized": row.content != body.content}


@router.delete("/knowledge/{key}")
def delete_knowledge(key: str, session: Session = Depends(get_session)) -> dict:
    """删除词条。**内置的也能删** —— 在库里写一条墓碑，读取时跳过。"""
    if not knowledge.remove(session, key):
        raise HTTPException(status_code=404, detail="词条不存在")
    record_audit(session, action="delete_knowledge", entity="knowledge_entry",
                 entity_id=key, detail={})
    session.commit()
    return {"ok": True}


@router.post("/knowledge/import")
def import_knowledge(body: KnowledgeImportIn, session: Session = Depends(get_session)) -> dict:
    """批量导入。和测试集同一条原则：**全对才收**。"""
    errors = knowledge.validate_import(body.entries)
    if errors:
        raise HTTPException(status_code=422, detail={"errors": errors})
    for key, v in body.entries.items():
        knowledge.upsert(session, key, str(v.get("title") or ""),
                         list(v.get("keywords") or []), str(v.get("content") or ""))
    record_audit(session, action="import_knowledge", entity="knowledge_entry",
                 entity_id="", detail={"count": len(body.entries)})
    session.commit()
    return {"ok": True, "imported": len(body.entries)}
