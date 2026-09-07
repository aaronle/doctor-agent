"""
数据库并发。

一次压测把问题打出来了：**120 个并发请求，44 个超时**（每个等满 30 秒）。
不是模型慢 —— 打的是 `telemetry/events` 与 `his/board`，两个都不调模型。

根因是 SQLite 的默认配置：

| PRAGMA | 默认 | 后果 |
| --- | --- | --- |
| `journal_mode` | `delete`（回滚日志） | **读挡写、写挡读**，全部请求排成一条队 |
| `busy_timeout` | 各连接不一 | 拿不到锁时的行为不确定 |
| `synchronous` | `FULL` | 每次提交都 fsync，写入慢一个量级 |

一期是单容器 SQLite，医生并发不高；但「一个医生点得快一点」和
「两个医生同时用」都会撞上这条队 —— 而表现是**转圈不动**，
不是报错，医生只会以为系统卡死了。
"""

from __future__ import annotations

import concurrent.futures as cf

from sqlalchemy import text


def test_sqlite_runs_in_wal_mode():
    """
    **WAL 是这里的关键。** 回滚日志模式下读写互斥；WAL 下读永远不被写挡住，
    而这个应用的绝大多数请求是读（候诊列表、看板、患者详情）。
    """
    from app.database import engine

    with engine.connect() as conn:
        mode = conn.execute(text("PRAGMA journal_mode")).scalar()
    assert str(mode).lower() == "wal", f"journal_mode={mode}，读写会互相挡住"


def test_sqlite_waits_for_lock_instead_of_failing():
    """
    拿不到锁要**等**，不是立刻抛 `database is locked`。

    这条和上一条是一对：WAL 把读写解耦，`busy_timeout` 兜住剩下的写写冲突。
    只做前者，两个写同时来仍会有一个当场失败。
    """
    from app.database import engine

    # **每一条连接都要有**，不能只验第一条。
    # `busy_timeout` 与 `synchronous` 是连接级设置：把 PRAGMA 挂在
    # `first_connect` 而不是 `connect` 上，池扩容出来的连接就全是默认值 ——
    # 而扩容恰恰发生在并发高的时候，也就是最需要这个设置的时候。
    # 这条用例第一版只开一条连接，那个错法测不出来。
    conns = [engine.connect() for _ in range(6)]
    try:
        timeouts = [int(c.execute(text("PRAGMA busy_timeout")).scalar()) for c in conns]
    finally:
        for c in conns:
            c.close()

    from app.database import BUSY_TIMEOUT_MS

    # **不能断言 `>= 5000`。** Python 的 sqlite3 驱动默认就给 5000
    # （`connect(timeout=5.0)`），那样写的话把整段 PRAGMA 删掉用例照样绿 ——
    # 第一版就是这么空过的，变异验证抓出来的。断言我们自己设的那个值。
    assert BUSY_TIMEOUT_MS > 5000, "阈值必须高于驱动默认值，否则这条用例测不到任何东西"
    assert all(t == BUSY_TIMEOUT_MS for t in timeouts), f"有连接没拿到我们设的值：{timeouts}"


def test_pool_is_large_enough_for_the_threadpool():
    """
    连接池必须**装得下线程池**。

    压测里那 44 个超时，报的其实是
    `QueuePool limit of size 5 overflow 10 reached, timeout 30.00` ——
    SQLAlchemy 默认池是 5+10=15 条，而 FastAPI 把同步 handler 丢进一个
    **40 线程**的池里跑。第 16 个并发请求开始就在等连接，等满 30 秒。

    表现是**转圈不动**，不是报错 —— 医生只会以为系统卡死了。

    SQLite 的连接是本地文件句柄，开一条几乎不要钱，
    所以这里按线程池的量级给，不必吝啬。
    """
    from app.database import engine

    # anyio 的默认线程上限是 40（`current_default_thread_limiter()` 要在
    # 事件循环里才能调，这里直接对着那个默认值断言）
    THREADPOOL = 40
    capacity = engine.pool.size() + engine.pool._max_overflow
    assert capacity >= THREADPOOL, (
        f"池容量 {capacity} < 线程池 {THREADPOOL}：并发一高就会有请求排队等满 pool_timeout"
    )


def test_sqlite_uses_normal_synchronous():
    """
    WAL + `synchronous=NORMAL`：每次提交不再 fsync，写入快一个量级，
    且在 WAL 下**仍然崩溃安全**（只在断电时可能丢最后几个事务，
    而这个应用的每一次写都还有审计日志兜底）。
    """
    from app.database import engine

    with engine.connect() as conn:
        # 0=OFF 1=NORMAL 2=FULL
        assert int(conn.execute(text("PRAGMA synchronous")).scalar()) == 1


def test_concurrent_reads_and_writes_all_succeed(client):
    """
    读写混打不能有失败。

    40 并发是保守的数字 —— 真正打出问题的那次是 120。用小一点的数是因为
    这条用例要在 CI 里稳定跑完，而它守的是「不会排成一条队」这个性质，
    不是具体的吞吐数字。
    """
    def write(i: int) -> int:
        return client.post(
            "/api/telemetry/events",
            json={"session_id": f"c{i}", "events": [{"event": "probe", "target": str(i)}]},
        ).status_code

    def read(_: int) -> int:
        return client.get("/api/his/board").status_code

    with cf.ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(write, range(20))) + list(pool.map(read, range(20)))

    failed = [r for r in results if r != 200]
    assert not failed, f"40 个并发请求里有 {len(failed)} 个失败：{failed[:5]}"
