"""日志配置（2026-09-13，devlog/077）。

## 为什么从 `main.py` 里搬出来

原先就三行 `logging.basicConfig(...)` 写在 `app/main.py` 顶部。问题不是"位置"，而是
**测不到**：`basicConfig` 只在"根 logger 还没有 handler"时才生效，而 pytest 的日志捕获
插件会先往根上挂 handler → 测试里这段配置**从来不会执行**，于是"日志写不出去/文件无限长大"
这类问题只能靠人肉发现（`logs/app.log` 恒为空那次事故就是这么漏的，见 devlog/013）。

搬出来之后：`build_file_handler()` 是纯函数，测试可以直接拿它做**真的轮转**并断言
备份文件的增删（`tests/test_services.py::test_log_file_handler_rotates_daily_and_prunes`）。

## 轮转策略（用户 2026-09-13 定的）

- **按天切**：`when="midnight"` → 备份名 `app.log.YYYY-MM-DD`。排查时的第一个动作就是
  "按天切一刀"（devlog/076 的教训：5.2MB / 33963 行跨了几个月，八月的历史记录差点被
  当成现行问题），按天命名正好对上这个用法；
- **保留 `backupCount` 份**（默认 7，约一周）：既有排查窗口，又不会无限增长；
- **UTF-8**：日志里有中文，缺了这个参数在 Windows 上按 GBK 写，中文会变成乱码；
- **本地时间**：与 `%(asctime)s` 的口径一致（`utc=False` 为默认值）。

> 注：`TimedRotatingFileHandler` **没有**大小上限 —— 真正的兜底是"按天 + 保留 N 份"这个
> 上界（本仓实测：正常使用一个月约 5MB；病态错误循环也已由 devlog/076 修掉）。
> 若将来某天单日日志异常大，优先看是不是又出现了"每轮一条 ERROR"这类循环。
>
> stdlib 两个容易踩的细节（写在这里，免得下次当成"轮转坏了"）：
> 1. `doRollover()` 开头是 `if os.path.exists(目标名): return`（"Already rolled over"）——
>    **目标名已存在时整次轮转会被静默跳过**（不改名、不裁剪）。正常使用不会撞上
>    （日期名唯一），但手造备份文件/时钟回拨时会；
> 2. 裁剪是**按文件名（=日期）排序取最旧**：所以"补历史备份"只能由远及近地补，
>    倒着来的话刚生成的那份会立刻被自己这轮删掉。
"""
import logging
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def build_file_handler(log_file: str | Path, backup_days: int) -> logging.Handler:
    """按天轮转的文件 handler（目录不存在会创建；`backup_days<=0` 表示不删旧文件）。"""
    path = Path(log_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    return TimedRotatingFileHandler(
        str(path),
        when="midnight",
        interval=1,
        backupCount=max(0, int(backup_days)),
        encoding="utf-8",
    )


def setup_logging(level: str, log_file: str | Path, backup_days: int) -> None:
    """根日志双通道：轮转文件 + 控制台。

    ⚠️ 与直接 `basicConfig` 一样，**只在根 logger 还没有 handler 时生效** ——
    测试环境（pytest 日志捕获）与某些宿主会先挂自己的 handler，那时这里静默跳过是
    正确行为（不抢别人已经配好的根）。要断言配置本身请直接用 `build_file_handler`。
    """
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format=LOG_FORMAT,
        handlers=[
            build_file_handler(log_file, backup_days),
            logging.StreamHandler(),
        ],
    )
