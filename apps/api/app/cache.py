"""
聚合结果缓存。

report-summary 要并发跑四个岗位，首次约 18 秒。医生在一次门诊里会反复
进出同一个患者，每次都重跑既慢又是重复计费。

缓存键包含**上下文哈希**：只要患者数据没变就命中，一旦开了医嘱、
改了病历导致上下文变化，键就变了，自动重算 —— 不需要手工失效。
"""

from __future__ import annotations

import hashlib
import json
import time

# 单容器部署，进程内缓存即可，不引入 Redis
_store: dict[str, tuple[float, dict]] = {}

TTL_SECONDS = 30 * 60
MAX_ENTRIES = 256


def context_key(patient_id: str, ctx: dict) -> str:
    digest = hashlib.sha256(json.dumps(ctx, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return f"{patient_id}:{digest}"


def get(key: str) -> dict | None:
    entry = _store.get(key)
    if entry is None:
        return None
    stored_at, payload = entry
    if time.monotonic() - stored_at > TTL_SECONDS:
        _store.pop(key, None)
        return None
    return payload


def put(key: str, payload: dict) -> None:
    if len(_store) >= MAX_ENTRIES:
        # 简单淘汰最旧的一条。条目上限只是防止长跑进程无限增长，
        # 不需要 LRU 的精确性。
        oldest = min(_store, key=lambda k: _store[k][0])
        _store.pop(oldest, None)
    _store[key] = (time.monotonic(), payload)


def clear() -> None:
    _store.clear()
