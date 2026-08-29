from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    release: str = "0.2.0-mvp"
    environment: str = "local"
    database_url: str = "sqlite:///./doctor-agent.db"
    runtime_mode: str = "mock"
    write_back_mode: str = "mock"
    cors_origins: str = "http://127.0.0.1:4173,http://localhost:4173"
    mock_step_delay_ms: int = 160

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="DOCTOR_AGENT_",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
