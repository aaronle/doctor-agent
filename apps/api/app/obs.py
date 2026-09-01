"""
结构化事件日志。

**为什么不用裸 logger.info 拼字符串**：出问题时要回答的是「哪个岗位、哪个病例、
第几次重试、耗时多少、为什么降级」，这些必须是**可过滤的字段**，不是一句话。
统一成单行 JSON 之后，`docker logs | jq` 就能查。

用法：

    from .obs import event

    event("agent_run", agent="record", patient="P001", ms=8900, degraded=False)

约定：

- **只记标识与度量，不记正文。** 病历内容、对话原文、模型输出一律不进日志 ——
  一期是虚构数据，但日志会被复制进工单、粘进聊天，这个习惯必须现在就立住。
  要看内容去 `agent_runs` 表，那里有权限边界。
- `event` 名用**下划线小写**，且是名词性的事实（`agent_degraded`），
  不是动作描述（`degrading agent now`）—— 前者能聚合计数，后者不能。
- 失败路径**必须也记耗时**。「失败得多快」本身是线索：
  3ms 失败多半是本地校验，20s 失败多半是网关超时。

查询示例：

    # 全部降级事件
    docker logs doctor-agent-mvp 2>&1 | grep '"event":"agent_degraded"' | jq .
    # 某个病例的完整链路
    docker logs doctor-agent-mvp 2>&1 | jq 'select(.patient=="P001")'
    # 超过 15 秒的岗位调用
    docker logs doctor-agent-mvp 2>&1 | jq 'select(.ms>15000)'
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger("doctor_agent.event")

# 绝不进日志的键。即便调用方手滑传了，也在这里拦掉。
_REDACTED = {
    "prompt", "role_prompt", "safety_layer", "content", "text", "dialog", "dialog_script",
    "fields", "record", "output", "reply", "api_key", "authorization",
}


def _clean(payload: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in payload.items():
        if key in _REDACTED:
            # 不静默丢弃：留个长度，既能判断「是不是空的」，又不泄露正文
            out[f"{key}_len"] = len(str(value)) if value is not None else 0
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value
        elif isinstance(value, (list, tuple, set)):
            out[key] = len(value)
        else:
            out[key] = str(value)[:120]
    return out


def event(name: str, **fields: Any) -> None:
    """记一条结构化事件。单行 JSON，便于 grep 与 jq。"""
    payload = {"event": name, **_clean(fields)}
    # 紧凑分隔符：默认的 ", " / ": " 会让 grep '"event":"agent_run"' 匹配不上，
    # 而 grep 是排障时最顺手的第一道筛子。顺带每行省几十字节。
    logger.info(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


@contextmanager
def timed(name: str, **fields: Any) -> Iterator[dict[str, Any]]:
    """
    给一段过程记时，成功与失败都落一条。

    上下文里 yield 出来的 dict 可以补字段，会一并记进最终那条事件：

        with timed("report_summary", patient=pid) as ev:
            result = await run()
            ev["degraded"] = result.degraded
    """
    start = time.perf_counter()
    extra: dict[str, Any] = {}
    try:
        yield extra
    except Exception as exc:
        event(name, **fields, **extra, ok=False, ms=round((time.perf_counter() - start) * 1000, 1),
              error=f"{type(exc).__name__}: {exc}")
        raise
    else:
        event(name, **fields, **extra, ok=True, ms=round((time.perf_counter() - start) * 1000, 1))
