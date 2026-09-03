"""
Agent 基类：提示词分层、输出校验、降级与记账。

每个岗位只需要声明「岗位层提示词、任务指令、输出 Schema、本地规则兜底」，
安全层、上下文装配、校验、降级、写 agent_runs 都在这里统一处理。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..agent_config import resolve
from ..model_gateway import model_is_configured
from ..skills import load_all_skills
from .safety import SAFETY_LAYER
from .runtime import Generation, GenerationError, generate
from ..models import AgentRun
from .context import project
from ..obs import event

PROMPT_BUNDLE_VERSION = "pb-1.0.0"

#: 引用原文时的引号约定。**这一条不能省，而且我省过一次、当天就被打脸。**
#:
#: 重构时我删掉了它，理由是「输出形状由工具调用的参数 schema 保证，
#: 不必再恳求模型配合」。**那个理由只对外层成立。**
#: 协议保证的是工具参数整体是合法 JSON；而模型有时会把嵌套对象
#: **再序列化成一个字符串**塞进字段，那一层内部的转义完全是它自由发挥 ——
#: 它会照着中文习惯写 `"病历近似偶服"`，半角引号当场把字符串截断。
#:
#: 实测 P001 的病情概况：8 次里 2 次因此解析失败、岗位静默降级。
QUOTE_CONVENTION = """【引用原文时】
需要引用病历原文、患者原话时一律用中文引号「」，**不要用半角双引号 `"`**——
它会截断字符串，导致这一段无法解析。"""

#: 数组字段的填法。**和引号约定同一类：都是在补协议保证不了的那部分。**
#:
#: 工具调用的参数 schema 声明了某个字段是数组，但模型仍会把它填成一个字符串，
#: 自己在里面用标签分隔。实测 `interview_agent` 的 `key_points` 与 `gaps`
#: **稳定**被糊成 `"<item>…</item><item>…</item></gaps>"` —— 那个岗位因此
#: 100% 降级、从来没真正工作过，而提示词里一个尖括号都没有。
#:
#: runtime 侧有还原（schemas._ITEM_TAG），但那是兜底；能不产生就别产生。
LIST_FIELD_CONVENTION = """【数组字段】
schema 里声明为数组的字段（如要点、待补问、支持证据），**每一条是数组里的一个独立元素**。
不要把多条合并成一个字符串，也不要用 `<item>`、`-`、换行等任何标记在字符串内部分隔。"""

#: 输出形状本身由工具调用的参数 schema 保证 —— 见 runtime.py。
#:
#: 这里原先有一段 OUTPUT_FORMAT（「只输出 JSON 对象」「字符串内不得出现半角双引号」），
#: 是给 `llm.extract_json_object` 打的补丁。那个函数从模型自由文本里抠 JSON，
#: 而未转义的半角引号会截断字符串、整份输出被丢弃 —— 那是真出过的事故。
#: 换成结构化生成之后，这两条连同被它们污染的安全层一起消失了。

@dataclass
class AgentOutcome:
    """一次 Agent 运行的结果。degraded 为真时界面必须显示降级标记。"""

    data: dict
    provider: str
    degraded: bool = False
    note: str = ""
    model: str = ""
    elapsed_ms: int = 0
    # 试运行要显示成本，不能只依赖运行日志（试运行本来就不进日志）
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class Agent:
    """
    岗位基类。

    刻意**不**做成 dataclass：子类是用类属性声明 key / role_prompt 的，
    而 dataclass 生成的 __init__ 会用字段默认值建同名实例属性，
    把子类的类属性整个盖掉（表现为 agent_runs.agent_key 全是空串）。
    """

    key: str = ""
    version: str = "mvp-1.0.0"

    #: 输出模型（Pydantic）。**同时是三样东西**：发给模型的工具参数 schema、
    #: 回来时的校验器、给人读的契约。
    #:
    #: 取代了原先手写的 `output_schema` dict —— 那份 dict 只是塞进提示词里的
    #: 一段文字，模型可以不照做，于是校验只能在事后手写一遍，两边还会不一致
    #: （共病的 risk_level 顶层写「高风险」、条目级写「高危」，而顶层根本没人校验）。
    output_model: type[BaseModel]

    #: 挂载的 skill 目录名。**岗位提示词的唯一来源。**
    #:
    #: 在此之前，同一份临床知识写在两个地方：这里的 `role_prompt` 字符串
    #: （产品路径在跑）和 `skills/<name>/SKILL.md`（编排路径在跑）。
    #: **它们已经漂了** —— 2026-09-03 给风险岗位加的两条（依据里的数字不许
    #: 自己算、阳性检查结论优先）只进了 .py，SKILL.md 至今没有，
    #: 而没有任何东西会因此报错、告警或让测试变红。
    #:
    #: 临床知识是最不该有第二份拷贝的东西：改了一份忘另一份，
    #: 两条路径就会对同一位患者给出不同口径的判断。
    skill: str = ""

    #: SKILL.md 正文里的占位符 → 运行时求值的函数。
    #:
    #: 科室闭集这类东西**必须留在代码里**：它是 `search_department` 工具和
    #: `validate()` 共同的判据，写死进 SKILL.md 就又变成两份，改一处忘一处。
    #: 占位符让 SKILL.md 只声明「这里要填闭集」，值仍然只有一个来源。
    prompt_placeholders: dict[str, Any] = {}

    @property
    def role_prompt(self) -> str:
        """从 SKILL.md 取岗位提示词（不含工具段落，产品路径不调工具）。"""
        if not self.skill:
            raise ValueError(f"{self.key} 未声明 skill —— 岗位提示词没有来源")
        body = load_all_skills()[self.skill].clinical_body
        for token, value in self.prompt_placeholders.items():
            body = body.replace(token, value() if callable(value) else str(value))
        # 占位符没被替换掉是配置错，不能让它原样发给模型 ——
        # 模型会照着「<DEPARTMENTS>」这个字面量去推荐科室
        leftover = re.findall(r"<[A-Z_]{3,}>", body)
        if leftover:
            raise ValueError(f"{self.key} 的 SKILL.md 有未替换的占位符：{leftover}")
        return body

    #: 模型档位。**缺省是推理档，不是快速档。**
    #:
    #: 之前所有岗位都硬编码成 clinical_fast，档位形同虚设。改成由子类声明后，
    #: 缺省必须落在能力更强的一侧：漏声明的后果应该是「慢一点」，
    #: 而不是「某个临床岗位被悄悄降级」——后者没有任何人会立刻发现。
    model_tier: str = "clinical_reasoning"

    # 该岗位实际需要的上下文字段。None 表示全量。
    # 只影响送进提示词的内容，不影响 fallback 能看到的数据。
    context_fields: tuple[str, ...] | None = None
    needs_lab_history: bool = False
    needs_exam_detail: bool = True

    # ------------------------------------------------------------ 子类实现

    def task_instruction(self, ctx: dict, **kwargs: Any) -> str:
        raise NotImplementedError

    def fallback(self, ctx: dict, **kwargs: Any) -> dict:
        """确定性本地规则。模型不可用时的兜底，必须能独立产出合法结果。"""
        raise NotImplementedError

    def validate(self, data: dict, ctx: dict) -> dict:
        """校验并规整模型输出。不合法时抛 ValueError，触发降级。"""
        return data

    # ------------------------------------------------------------ 通用流程

    def specialty_prompt(self, ctx: dict) -> str:
        dept = ctx.get("dept") or "全科"
        return f"当前科室：{dept}。请使用该科室的常规术语与诊疗习惯，不要越出本科范围给出建议。"

    def build_prompt(self, ctx: dict, *, role_prompt: str | None = None, **kwargs: Any) -> tuple[str, str]:
        """装配 (system, user) 两段。

        **不再把 JSON Schema 塞进提示词。** 输出形状由 runtime 的工具参数 schema
        保证；写在提示词里只是让模型多读一遍，而它照样可以不照做。
        """
        prompt_ctx = project(
            ctx,
            fields=self.context_fields,
            lab_history=self.needs_lab_history,
            exam_detail=self.needs_exam_detail,
        )
        system = "\n\n".join(
            [
                SAFETY_LAYER,
                f"【岗位职责】\n{role_prompt or self.role_prompt}",
                f"【专科背景】\n{self.specialty_prompt(ctx)}",
                QUOTE_CONVENTION,
                LIST_FIELD_CONVENTION,
            ]
        )
        user = "\n\n".join(
            [
                f"【任务指令】\n{self.task_instruction(ctx, **kwargs)}",
                f"【患者上下文】\n{json.dumps(prompt_ctx, ensure_ascii=False)}",
            ]
        )
        return system, user

    async def run(
        self,
        session: Session,
        ctx: dict,
        *,
        config_override=None,
        record: bool = True,
        **kwargs: Any,
    ) -> AgentOutcome:
        """
        跑一次该岗位。

        config_override / record 两个参数只给控制台的试运行用：

        - `config_override` 让调用方指定用哪一版配置（草稿或某个历史版本），
          而不是固定用已发布版。发布前要能看到改动的效果，就必须能绕过 resolve。
        - `record=False` 让本次调用不进 agent_runs。运行日志的定位是「生产运行的
          可追溯记录」，把调优期的大量试错混进去，成功率这个数字就废了 ——
          而那恰恰是最需要靠它判断线上健康度的时候。

        产品路径一律用默认值，不传这两个参数。
        """
        # 运行时读已发布配置：Prompt 与模型档位都可能被控制台改过。
        # 读不到已发布版本才回落代码默认值，所以首次部署无需先建配置。
        config = config_override or resolve(session, self)

        if not model_is_configured():
            outcome = AgentOutcome(
                data=self.fallback(ctx, **kwargs),
                provider="local-rules",
                degraded=True,
                note="模型通道未配置，已降级为本地规则",
            )
            event("agent_degraded", agent=self.key, patient=ctx.get("id"), reason="unconfigured",
                  tier=config.model_tier, recorded=record)
            if record:
                self._record(session, ctx, outcome, status="degraded", error="unconfigured", config=config)
            return outcome

        try:
            system, user = self.build_prompt(ctx, role_prompt=config.role_prompt, **kwargs)
            result: Generation = await generate(
                system=system,
                user=user,
                output_model=self.output_model,
                model_name=config.model,
            )
            # Pydantic 已经保证了形状；validate() 现在只做**临床归一化**
            data = self.validate(result.data, ctx)
        except (GenerationError, ValueError, KeyError, TypeError) as exc:
            outcome = AgentOutcome(
                data=self.fallback(ctx, **kwargs),
                provider="local-rules",
                degraded=True,
                note=f"模型不可用，已降级为本地规则：{exc}",
            )
            # 记异常类型而不是整段消息：类型能聚合计数（今天 12 次 LlmError），
            # 消息各不相同，聚合不了
            event("agent_degraded", agent=self.key, patient=ctx.get("id"),
                  reason=type(exc).__name__, detail=str(exc)[:160],
                  tier=config.model_tier, recorded=record)
            if record:
                self._record(session, ctx, outcome, status="degraded", error=str(exc), config=config, raw=getattr(exc, "raw_excerpt", ""))
            return outcome

        event("agent_run", agent=self.key, patient=ctx.get("id"), tier=config.model_tier,
              model=result.model, ms=result.elapsed_ms, tokens=result.total_tokens,
              version=config.version, source=config.source, recorded=record)

        outcome = AgentOutcome(
            data=data,
            provider=result.model or "claude",
            model=result.model,
            elapsed_ms=result.elapsed_ms,
        )
        if record:
            self._record(
                session,
                ctx,
                outcome,
                status="ok",
                config=config,
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                total_tokens=result.total_tokens,
            )
        # 把 token 与模型带回给调用方 —— 试运行要显示成本，不能只依赖日志
        outcome.prompt_tokens = result.prompt_tokens
        outcome.completion_tokens = result.completion_tokens
        outcome.total_tokens = result.total_tokens
        return outcome

    def _record(
        self,
        session: Session,
        ctx: dict,
        outcome: AgentOutcome,
        *,
        status: str,
        error: str = "",
        config=None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
        raw: str = "",
    ) -> None:
        # 只存上下文摘要与哈希，不存完整病历：运行日志不应成为病历副本
        digest = {
            "patient_id": ctx.get("id", ""),
            "dept": ctx.get("dept", ""),
            "context_keys": sorted(ctx.keys()),
            "context_hash": hashlib.sha256(
                json.dumps(ctx, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()[:16],
            # 记下这次跑的是哪一版配置，出问题能定位到具体版本而不是「某次改动」
            "config_version": getattr(config, "version", self.version),
            "config_source": getattr(config, "source", "code-default"),
            "model_tier": getattr(config, "model_tier", self.model_tier),
        }
        # 失败样本：只在失败时留模型原文的前 500 字符。
        # 成功的输出不留 —— 那会让日志变成病历副本；500 字够定位格式问题，
        # 不足以复原一份病历。早先「未转义半角双引号导致 JSON 解析失败」
        # 就是靠人工抓原文才定位的，当时日志里什么都看不到。
        if status != "ok" and raw:
            digest["raw_excerpt"] = str(raw)[:500]
        session.add(
            AgentRun(
                agent_key=self.key,
                patient_id=ctx.get("id", ""),
                model=outcome.model,
                provider=outcome.provider,
                status=status,
                elapsed_ms=outcome.elapsed_ms,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                prompt_bundle_version=PROMPT_BUNDLE_VERSION,
                input_digest=digest,
                output=outcome.data if isinstance(outcome.data, dict) else {},
                error=error,
            )
        )
        session.commit()


def require_list(data: dict, key: str) -> list:
    """取出必须是列表的字段，类型不符即视为非法输出。"""
    value = data.get(key)
    if not isinstance(value, list):
        raise ValueError(f"字段 {key} 必须是数组，实际为 {type(value).__name__}")
    return value


def require_dict(data: dict, key: str) -> dict:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"字段 {key} 必须是对象，实际为 {type(value).__name__}")
    return value
