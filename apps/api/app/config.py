from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """产品侧运行配置，全部以 DOCTOR_AGENT_ 前缀注入。"""

    release: str = "0.3.0-mvp"
    environment: str = "local"
    database_url: str = "sqlite:///./doctor-agent.db"
    runtime_mode: str = "live"
    write_back_mode: str = "local"
    cors_origins: str = "http://127.0.0.1:4173,http://localhost:4173"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="DOCTOR_AGENT_",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


class AiSettings(BaseSettings):
    """
    模型通道配置，对齐 Ticket System 的 OpenAI 兼容第三方网关。

    刻意不加 DOCTOR_AGENT_ 前缀：与 ts-it-service 使用同一组变量名，
    便于两个项目共用 .env.runtime 的注入方式，减少一处口径分裂。
    """

    api_key: str = ""
    base_url: str = "https://www.meatdc.com/v1"
    # 2026-09-02 由 Haiku 4.5 换到 Sonnet 5。六个岗位做的是「读证据 → 下结论 → 标依据」，
    # Haiku 在这类任务上更早停手、更容易漏掉该查的工具，产出常是「血糖控制不佳」这种
    # 没有数值的空话。临床上「少查一次」的代价高于多花的那几秒。
    fast_model: str = "claude-sonnet-5"
    smart_model: str = "claude-sonnet-5"
    timeout_ms: int = 45000
    # "rules" 时全部 Agent 走确定性本地规则，不调模型；用于离线开发与测试
    test_mode: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="AI_",
        extra="ignore",
    )

    @property
    def configured(self) -> bool:
        return bool(self.api_key) and self.test_mode != "rules"

    @property
    def timeout_seconds(self) -> float:
        return self.timeout_ms / 1000


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_ai_settings() -> AiSettings:
    return AiSettings()
