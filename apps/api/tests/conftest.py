"""
测试夹具。

统一用 AI_TEST_MODE=rules：全部 Agent 走确定性本地规则，不调真实模型。
API 测试要验的是端点形状、写入、审计与安全边界，不是模型输出质量；
真实模型的临床质量由离线评测集负责，不该让 CI 依赖外部网关。
"""

import os
import sys
from pathlib import Path

import pytest

API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))

TEST_DB = API_ROOT.parents[1] / "test-doctor-agent.db"

os.environ["AI_TEST_MODE"] = "rules"
os.environ["AI_API_KEY"] = ""
os.environ["DOCTOR_AGENT_DATABASE_URL"] = f"sqlite:///{TEST_DB}"
os.environ["DOCTOR_AGENT_ENVIRONMENT"] = "test"


def _drop_test_db() -> None:
    """
    删测试库。**连 `-wal` / `-shm` 一起删。**

    改成 WAL 模式后，SQLite 会在主库旁边生成两个伴生文件。
    只删主库、留着伴生文件，下一次跑会撞 `sqlite3.OperationalError: disk I/O error`
    —— 报错文字完全不提 WAL，看起来像磁盘坏了。
    """
    # **先把连接池关掉再删文件。** 回滚日志模式下，删掉一个还被打开的库
    # 只是把目录项摘掉，已有 fd 照常能用；WAL 模式不行 —— 伴生文件被抽走
    # 之后，池里那些连接下一次用就是 `disk I/O error`。
    try:
        from app.database import engine

        engine.dispose()
    except Exception:  # noqa: BLE001 - 库还没被导入过时正常
        pass

    for suffix in ("", "-wal", "-shm"):
        path = TEST_DB.with_name(TEST_DB.name + suffix)
        if path.exists():
            path.unlink()


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    _drop_test_db()

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client

    _drop_test_db()


@pytest.fixture(autouse=True)
def clear_summary_cache():
    """每个用例前清聚合缓存，避免相互串味。"""
    from app import cache

    cache.clear()
    yield
