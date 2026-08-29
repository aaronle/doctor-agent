"""
Doctor Agent 产品 API。

单容器架构：同一个 FastAPI 既提供 /api/*，也提供 Vue 构建产物，
未匹配路径回落 index.html 以支持 history 模式路由。
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .agents import agent_inventory
from .config import get_ai_settings, get_settings
from .database import SessionLocal, engine, init_database
from .models import OperationLog
from .routers import admin as admin_router
from .routers import config as config_router
from .routers import emr as emr_router
from .routers import his as his_router
from .seed import seed_database

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("doctor_agent")

settings = get_settings()
# apps/api/app/main.py → 上溯三层到 apps/，再进 web/dist
WEB_DIST = Path(__file__).resolve().parents[2] / "web/dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_database()
    session = SessionLocal()
    try:
        counts = seed_database(session)
        logger.info('{"event":"seed","result":%s}', counts)
    finally:
        session.close()
    yield


app = FastAPI(title="Doctor Agent Product API", version=settings.release, lifespan=lifespan)

# 本地开发时 Vite 独立起服务，需放开跨域；正式部署为同源，按白名单收紧
allow_origins = ["*"] if settings.environment == "local" else settings.cors_origin_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=settings.environment != "local",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def operation_log(request: Request, call_next):
    """每请求留痕。只记通道层事实，不记请求体与响应体。"""
    request_id = request.headers.get("x-request-id") or uuid4().hex[:16]
    started = time.monotonic()
    error_code = ""
    try:
        response = await call_next(request)
        status = response.status_code
    except Exception as exc:
        status = 500
        error_code = type(exc).__name__
        raise
    finally:
        if request.url.path.startswith("/api/"):
            session = SessionLocal()
            try:
                session.add(
                    OperationLog(
                        request_id=request_id,
                        method=request.method,
                        path=request.url.path,
                        status=status,
                        elapsed_ms=round((time.monotonic() - started) * 1000, 2),
                        error_code=error_code,
                    )
                )
                session.commit()
            finally:
                session.close()

    response.headers["x-request-id"] = request_id
    return response


app.include_router(config_router.router)
app.include_router(his_router.router)
app.include_router(emr_router.router)
app.include_router(admin_router.router)


@app.get("/api/health")
def health() -> dict:
    """健康指纹。刻意不回传任何密钥或其片段。"""
    ai = get_ai_settings()
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        database = "ready"
    except Exception as exc:  # noqa: BLE001 — 健康检查须吞掉异常并如实上报
        database = f"error: {type(exc).__name__}"

    return {
        "ok": database == "ready",
        "release": settings.release,
        "database": database,
        "ai": "configured" if ai.configured else "unconfigured",
        "aiModels": {"fast": ai.fast_model, "smart": ai.smart_model},
        "agents": agent_inventory(),
        "runtime_mode": settings.runtime_mode,
        "write_back_mode": settings.write_back_mode,
        "data_classification": "MOCK_ONLY_NO_REAL_PATIENT_DATA",
        "time": datetime.now(UTC).isoformat(),
    }


# 同源提供 Vue 构建产物。dist 不存在时（纯后端开发）跳过挂载，不影响 /api/*。
if WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa_fallback(path: str) -> FileResponse:
        candidate = WEB_DIST / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        # history 模式：未匹配路径一律回 index.html，由前端路由接管
        return FileResponse(WEB_DIST / "index.html")
