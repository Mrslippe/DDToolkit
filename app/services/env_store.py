"""共享 .env 原子写工具（B 站 / 微博凭据共用）。

桌面端数据目录 = %APPDATA%/DDtoolkit/.env，开发 = 项目根 .env。
写采用临时文件 + os.replace 原子替换（进程中断不留半写文件），
threading.Lock 防多登录流程并发写互相覆盖。
"""
import logging
import os
import tempfile
import threading

from app.core.config import settings

logger = logging.getLogger(__name__)

ENV_PATH = settings.DATA_DIR / ".env"

_env_lock = threading.Lock()


def save_env_keys(values: dict[str, str]) -> None:
    """按 key 覆盖写入 .env（原子替换），并刷新 settings 对应属性。

    values: {"BILI_SESSDATA": "...", "WEIBO_COOKIE": "...", ...}
    写成功后 reload dotenv + setattr(settings, key, value)。
    """
    if not ENV_PATH.exists():
        # 首次登录（桌面端 %APPDATA%/DDtoolkit 无 .env）：创建父目录并新建文件，
        # 否则凭据只活在内存、重启即丢（B 站/微博同样受影响）
        ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
        ENV_PATH.touch(exist_ok=True)

    with _env_lock:
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines(keepends=True) if ENV_PATH.exists() else []
        target_keys = set(values.keys())
        new_lines: list[str] = []
        seen: set[str] = set()

        for line in lines:
            key = line.split("=", 1)[0].strip() if "=" in line else ""
            if key in target_keys:
                if key not in seen:
                    seen.add(key)
                    new_lines.append(f"{key}={values[key]}\n")
            else:
                new_lines.append(line)

        for key in target_keys:
            if key not in seen:
                new_lines.append(f"{key}={values[key]}\n")

        fd, tmp_path = tempfile.mkstemp(
            dir=str(ENV_PATH.parent), prefix=".env.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write("".join(new_lines))
            os.replace(tmp_path, ENV_PATH)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    reload_env_keys(list(values.keys()))


def reload_env_keys(keys: list[str]) -> None:
    """重载 dotenv 并把指定 key 同步回 settings 类属性（导入期读死需手动刷新）。"""
    from dotenv import load_dotenv
    load_dotenv(ENV_PATH, override=True)
    for key in keys:
        setattr(settings, key, os.getenv(key, ""))
