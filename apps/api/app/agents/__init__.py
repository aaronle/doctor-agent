"""
八个 Agent 岗位的注册表。

诊断岗位一头承鉴别诊断与诊断管理。
病历单段续写（record_field）是病历岗位的子能力，不单列为岗位。

「AI 追问提示」占两个岗位而不是一个：出清单（`followup_plan`，开场算一次）
与判定覆盖（`followup_coverage`，对话推进时增量算）是两件事 ——
前者要看患者全部档案，后者只看对话与清单。合成一个岗位会让后者
每次都拖着一整份档案跑，既慢又容易跑偏。
"""

from .base import PROMPT_BUNDLE_VERSION, Agent, AgentOutcome
from .comorbidity import ComorbidityAgent
from .diagnosis import DiagnosisAgent
from .record import RECORD_SECTIONS, SECTION_KEYS, SECTION_LABELS, RecordAgent, RecordFieldAgent
from .risk import RiskAgent, hard_rule_alerts, merge_risks
from .summary import SummaryAgent
from .interview import InterviewSummaryAgent
from .followup import FollowUpCoverageAgent, FollowUpPlanAgent

summary_agent = SummaryAgent()
record_agent = RecordAgent()
record_field_agent = RecordFieldAgent()
diagnosis_agent = DiagnosisAgent()
risk_agent = RiskAgent()
comorbidity_agent = ComorbidityAgent()
interview_agent = InterviewSummaryAgent()
followup_plan_agent = FollowUpPlanAgent()
followup_coverage_agent = FollowUpCoverageAgent()

# 供健康接口与运行控制台展示的岗位清单
AGENT_REGISTRY: tuple[tuple[str, str, str], ...] = (
    ("summary", "病情概况智能体", summary_agent.version),
    ("record", "病历生成智能体", record_agent.version),
    ("diagnosis", "诊断智能体", diagnosis_agent.version),
    ("risk", "风险管理智能体", risk_agent.version),
    ("comorbidity", "共病管理智能体", comorbidity_agent.version),
    ("interview", "问诊小结智能体", interview_agent.version),
    ("followup_plan", "AI 追问提示智能体", followup_plan_agent.version),
    ("followup_coverage", "追问覆盖判定智能体", followup_coverage_agent.version),
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
    "interview_agent",
    "followup_plan_agent",
    "followup_coverage_agent",
]
