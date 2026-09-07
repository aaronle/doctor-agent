from collections.abc import Generator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings
from .models import Base

settings = get_settings()
_IS_SQLITE = settings.database_url.startswith("sqlite")
connect_args = {"check_same_thread": False} if _IS_SQLITE else {}
#: 连接池容量。**必须装得下 FastAPI 的线程池**（默认 40 条）。
#:
#: SQLAlchemy 默认是 5+10=15 —— 压测里 120 并发有 44 个超时，报的就是
#: `QueuePool limit of size 5 overflow 10 reached, timeout 30.00`：
#: 第 16 个并发请求开始在等连接，等满 30 秒。表现是**转圈不动**不是报错，
#: 医生只会以为系统卡死了。
#:
#: SQLite 的连接是本地文件句柄，开一条几乎不要钱，按线程池量级给即可。
#: 锁等待。**Python 的 sqlite3 驱动默认就给 5000ms**（`connect(timeout=5.0)`），
#: 所以「设成 5000」等于什么都没做 —— 早先那条断言 `>= 5000` 因此是空过的，
#: 去掉整个 PRAGMA 它照样绿。
#:
#: 给 15 秒是因为 WAL 只解耦了读写，**写写之间仍然互斥**：
#: 一次 `report-summary` 要写四条 `agent_runs`，撞上埋点批量入库时会排队。
#: 等 15 秒好过当场抛 `database is locked` —— 后者医生看到的是操作失败。
BUSY_TIMEOUT_MS = 15_000

_POOL_SIZE = 20
_MAX_OVERFLOW = 40

_pool_kwargs = (
    {
        "pool_size": _POOL_SIZE,
        "max_overflow": _MAX_OVERFLOW,
        # 真拿不到连接时**快点失败**，不要挂 30 秒。
        # 上游看到 500 会重试或报错；挂着不动谁都不知道发生了什么
        "pool_timeout": 10,
        # 回收长期空闲连接，免得容器里被中间设备静默掐断
        "pool_recycle": 1800,
        "pool_pre_ping": True,
    }
    if _IS_SQLITE
    else {}
)

engine = create_engine(
    settings.database_url, connect_args=connect_args, future=True, **_pool_kwargs
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


if _IS_SQLITE:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record) -> None:  # pragma: no cover - 由并发用例覆盖
        """
        每条连接都要设的三个 PRAGMA。

        起因是一次压测：**120 个并发请求，44 个超时**，每个等满 30 秒。
        打的是 `telemetry/events` 与 `his/board`，两个都不调模型 ——
        慢的不是 AI，是数据库把所有请求排成了一条队。

        | PRAGMA | 默认 | 改成 | 为什么 |
        | --- | --- | --- | --- |
        | `journal_mode` | `delete` | `WAL` | 回滚日志下**读挡写、写挡读**；WAL 下读永不被挡 |
        | `busy_timeout` | 5000（驱动给的） | `15000` | WAL 下写写仍会冲突，等久一点好过报错 |
        | `synchronous` | `FULL` | `NORMAL` | 每次提交都 fsync 太贵；WAL 下 NORMAL 仍然崩溃安全 |

        **挂在 `connect` 事件上而不是启动时执行一次。** `journal_mode` 是
        库级持久设置（写进文件头），但 `busy_timeout` 与 `synchronous`
        是**连接级**的 —— 连接池每开一条新连接都要重设，
        只在启动时设一次，池扩容出来的连接就没有。

        WAL 需要本地文件系统。一期是单容器 + 本地挂载卷，成立；
        若将来换网络存储要改回来（那时也该换 Postgres 了）。
        """
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()


def init_database() -> None:
    """
    幂等建表 + 补列，沿用 Ticket System 的做法。

    create_all 只建缺失的表，不会改已存在表的结构；因此模型新增字段时，
    这里按 PRAGMA table_info 的差集补 ALTER，避免每加一列都要人工迁移。
    正式环境的可追溯迁移仍由 Alembic 负责。
    """
    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {col["name"] for col in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                ddl_type = column.type.compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl_type}'))


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
