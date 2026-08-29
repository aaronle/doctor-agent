import json
from functools import lru_cache
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_FILE = PROJECT_ROOT / "docs" / "testing" / "fixtures" / "phase1-patients.json"


@lru_cache
def fixture_document() -> dict[str, Any]:
    with FIXTURE_FILE.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def list_fixtures() -> list[dict[str, Any]]:
    return fixture_document()["fixtures"]


def get_fixture_by_patient(patient_id: str) -> dict[str, Any] | None:
    return next(
        (item for item in list_fixtures() if item["patient"]["patient_id"] == patient_id),
        None,
    )


def public_patient(fixture: dict[str, Any]) -> dict[str, Any]:
    patient = fixture["patient"]
    encounter = fixture["encounter"]
    return {
        "fixture_id": fixture["fixture_id"],
        "specialty": fixture["specialty"],
        "scenario": fixture["scenario"],
        "patient_id": patient["patient_id"],
        "encounter_id": encounter["encounter_id"],
        "name": patient["name"],
        "gender": patient["gender"],
        "age": patient["age"],
        "chief_complaint": encounter["chief_complaint"],
        "allergy": encounter["allergy"],
        "facts": fixture.get("facts", {}),
    }
