from dataclasses import asdict, dataclass

from .schemas import TaskType


@dataclass(frozen=True)
class AgentProfile:
    agent_id: str
    display_name: str
    version: str
    responsibilities: tuple[str, ...]


AGENT_PROFILES: dict[TaskType, AgentProfile] = {
    "voice_interview": AgentProfile(
        agent_id="voice_interview_agent",
        display_name="语音问诊智能体",
        version="mvp-0.2.0",
        responsibilities=("问诊转写", "结构化采集", "漏问提示"),
    ),
    "condition_summary": AgentProfile(
        agent_id="condition_summary_agent",
        display_name="病情概况智能体",
        version="mvp-0.2.0",
        responsibilities=("就诊摘要", "主要问题", "数据缺失与冲突"),
    ),
    "record_generation": AgentProfile(
        agent_id="record_generation_agent",
        display_name="病历生成智能体",
        version="mvp-0.2.0",
        responsibilities=("病历草稿", "段落级证据", "质量校验"),
    ),
    "differential_diagnosis": AgentProfile(
        agent_id="diagnosis_agent",
        display_name="诊断智能体",
        version="mvp-0.2.0",
        responsibilities=("鉴别诊断", "支持与反对证据", "不确定性管理"),
    ),
    "diagnosis_management": AgentProfile(
        agent_id="diagnosis_agent",
        display_name="诊断智能体",
        version="mvp-0.2.0",
        responsibilities=("诊断清单", "主诊断一致性", "编码待确认"),
    ),
    "risk_management": AgentProfile(
        agent_id="risk_management_agent",
        display_name="风险管理智能体",
        version="mvp-0.2.0",
        responsibilities=("风险分层", "红旗证据", "处置闭环"),
    ),
    "comorbidity_management": AgentProfile(
        agent_id="comorbidity_agent",
        display_name="共病管理智能体",
        version="mvp-0.2.0",
        responsibilities=("共病分组", "相互影响", "照护缺口与随访"),
    ),
}


def get_agent_profile(task_type: TaskType) -> AgentProfile:
    return AGENT_PROFILES[task_type]


def public_agent_inventory() -> list[dict]:
    unique = {profile.agent_id: profile for profile in AGENT_PROFILES.values()}
    return [
        {
            **{key: value for key, value in asdict(profile).items() if key != "version"},
            "agent_version": profile.version,
            "responsibilities": list(profile.responsibilities),
        }
        for profile in unique.values()
    ]
