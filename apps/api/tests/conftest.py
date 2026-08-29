import os

os.environ.setdefault("DOCTOR_AGENT_ENVIRONMENT", "test")
os.environ.setdefault("DOCTOR_AGENT_DATABASE_URL", "sqlite:///./test-doctor-agent.db")
os.environ.setdefault("DOCTOR_AGENT_MOCK_STEP_DELAY_MS", "0")

import pytest
from fastapi.testclient import TestClient

from app.database import Base, engine
from app.main import app


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer mock-token-doctor_001"}
