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


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    if TEST_DB.exists():
        TEST_DB.unlink()

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client

    if TEST_DB.exists():
        TEST_DB.unlink()


@pytest.fixture(autouse=True)
def clear_summary_cache():
    """每个用例前清聚合缓存，避免相互串味。"""
    from app import cache

    cache.clear()
    yield
