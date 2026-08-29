# Doctor Agent 契约包

本目录由 `npm run contracts:export` 从 FastAPI/Pydantic 单一事实源生成，用于前端、Mock Runtime、未来 AgentScope Adapter 和契约测试共同消费。

- `openapi.json`：产品 API 的 OpenAPI 3.1 定义。
- `schemas/task_request_v1.json`：产品向 Agent Gateway 提交任务。
- `schemas/task_event_v1.json`：SSE 业务状态事件，不包含模型思维链。
- `schemas/semantic_result_v1.json`：智能体语义结果。
- `schemas/card_view_model_v1.json`：集成层返回给产品的卡片模型。
- `schemas/agent_result_action_v1.json`：医生采纳、编辑、拒绝、反馈与风险处置动作。

禁止手工编辑生成的 JSON 文件；契约字段变更应先修改 `apps/api/app/schemas.py`，运行导出并通过契约测试。
