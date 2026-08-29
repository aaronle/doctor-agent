"""
六个 Agent 岗位的注册表。

产品功能有七个、Agent 岗位有六个：诊断岗位一头承鉴别诊断与诊断管理。
病历单段续写（record_field）是病历岗位的子能力，不单列为岗位。
"""

from .base import PROMPT_BUNDLE_VERSION, Agent, AgentOutcome
from .comorbidity import ComorbidityAgent
from .diagnosis import DiagnosisAgent
from .record import RECORD_SECTIONS, SECTION_KEYS, SECTION_LABELS, RecordAgent, RecordFieldAgent
from .risk import RiskAgent, hard_rule_alerts, merge_risks
from .summary import SummaryAgent
from .voice import VoiceSummaryAgent, VoiceTurnAgent

summary_agent = SummaryAgent()
record_agent = RecordAgent()
record_field_agent = RecordFieldAgent()
diagnosis_agent = DiagnosisAgent()
risk_agent = RiskAgent()
comorbidity_agent = ComorbidityAgent()
voice_turn_agent = VoiceTurnAgent()
voice_summary_agent = VoiceSummaryAgent()

# 供健康接口与运行控制台展示的岗位清单
AGENT_REGISTRY: tuple[tuple[str, str, str], ...] = (
    ("summary", "病情概况智能体", summary_agent.version),
    ("record", "病历生成智能体", record_agent.version),
    ("diagnosis", "诊断智能体", diagnosis_agent.version),
    ("risk", "风险管理智能体", risk_agent.version),
    ("comorbidity", "共病管理智能体", comorbidity_agent.version),
    ("voice", "语音问诊智能体", voice_turn_agent.version),
)


def agent_inventory() -> list[dict]:
    return [{"agent_key": key, "name": name, "version": version} for key, name, version in AGENT_REGISTRY]


__all__ = [
    "AGENT_REGISTRY",
    "PROMPT_BUNDLE_VERSION",
    "RECORD_SECTIONS",
    "SECTION_KEYS",
    "SECTION_LABELS",
    "Agent",
    "AgentOutcome",
    "agent_inventory",
    "comorbidity_agent",
    "diagnosis_agent",
    "hard_rule_alerts",
    "merge_risks",
    "record_agent",
    "record_field_agent",
    "risk_agent",
    "summary_agent",
    "voice_summary_agent",
    "voice_turn_agent",
]
