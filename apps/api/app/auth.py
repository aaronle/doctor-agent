from dataclasses import dataclass

from fastapi import Header, HTTPException, status


@dataclass(frozen=True)
class CurrentActor:
    user_id: str
    role: str


def require_actor(authorization: str | None = Header(default=None)) -> CurrentActor:
    if authorization != "Bearer mock-token-doctor_001":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态无效或已过期")
    return CurrentActor(user_id="doctor_001", role="outpatient_doctor")
