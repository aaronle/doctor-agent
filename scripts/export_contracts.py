import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = PROJECT_ROOT / "apps" / "api"
sys.path.insert(0, str(API_ROOT))

from app.main import app  # noqa: E402
from app.schemas import (  # noqa: E402
    CardViewModelV1,
    ResultActionV1,
    SemanticResultV1,
    TaskEventV1,
    TaskRequestV1,
)


OUTPUT = PROJECT_ROOT / "packages" / "contracts"
SCHEMAS = OUTPUT / "schemas"
SCHEMAS.mkdir(parents=True, exist_ok=True)

(OUTPUT / "openapi.json").write_text(
    json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)

models = {
    "task_request_v1": TaskRequestV1,
    "task_event_v1": TaskEventV1,
    "semantic_result_v1": SemanticResultV1,
    "card_view_model_v1": CardViewModelV1,
    "agent_result_action_v1": ResultActionV1,
}
for name, model in models.items():
    (SCHEMAS / f"{name}.json").write_text(
        json.dumps(model.model_json_schema(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

print(f"Exported OpenAPI and {len(models)} JSON Schemas to {OUTPUT}")
