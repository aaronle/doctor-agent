"""
入参模型的共享基类。

**拒绝未知字段。** Pydantic 默认静默丢弃它们 —— 前端把 `patient_id` 拼成
`patientId`，请求会 200 返回、字段用默认值，行为看着像「功能没生效」，
排查时完全没有线索。宁可 422 报出来。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class StrictIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
