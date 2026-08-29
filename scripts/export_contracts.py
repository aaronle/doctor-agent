"""
导出产品 API 的 OpenAPI 契约。

一期前端按 V4.3 定义的 20 个端点实现，因此契约的唯一事实源就是 FastAPI
应用本身。原先另外导出的 task_request_v1 等五份 JSON Schema 属于 Agent
Gateway 的任务契约，MVP 阶段产品直连 Agent、不经任务队列，故不再导出；
接入 AgentScope 时再恢复。
"""

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = PROJECT_ROOT / "apps" / "api"
sys.path.insert(0, str(API_ROOT))

from app.main import app  # noqa: E402

OUTPUT = PROJECT_ROOT / "packages" / "contracts"
OUTPUT.mkdir(parents=True, exist_ok=True)

(OUTPUT / "openapi.json").write_text(
    json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)

paths = len(app.openapi().get("paths", {}))
print(f"已导出 OpenAPI（{paths} 个路径）到 {OUTPUT / 'openapi.json'}")
