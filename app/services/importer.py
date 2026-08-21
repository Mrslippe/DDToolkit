"""从 CSV 导入 VTuber + Account，去重"""
import csv
import logging
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.vtuber import VTuber, Account

logger = logging.getLogger(__name__)


def import_from_file(filepath: str | None = None, db: Session | None = None) -> dict:
    """
    读取 CSV，flag=1 的行导入。去重后创建 VTuber + Account。

    db 可注入外部会话（测试用）；未注入时自建并在结束时关闭。
    """
    path = Path(filepath or settings.VTUBER_LIST_FILE)
    if not path.exists():
        logger.warning(f"列表文件不存在: {path}")
        return {"created": 0, "skipped": 0, "errors": [f"文件不存在: {path}"]}

    own_session = db is None
    if own_session:
        db = SessionLocal()

    result: dict = {"created": 0, "skipped": 0, "errors": []}

    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if not header:
                return {"created": 0, "skipped": 0, "errors": ["CSV 无表头"]}
            try:
                flag_i = header.index("flag")
                name_i = header.index("vtuber_name" if "vtuber_name" in header else "name")
                plat_i = header.index("platform")
                uid_i = header.index("platform_uid" if "platform_uid" in header else "uid")
            except ValueError as e:
                return {"created": 0, "skipped": 0, "errors": [f"CSV 缺少必要列: {e}"]}

            # 预加载已有数据
            existing_accounts = {
                (r.platform, r.platform_uid): r
                for r in db.query(Account).all()
            }
            existing_vtubers = {v.name: v for v in db.query(VTuber).all()}

            for line_no, row in enumerate(reader, 2):
                if len(row) <= max(flag_i, name_i, plat_i, uid_i):
                    result["errors"].append(f"第 {line_no} 行字段不足")
                    continue

                flag = row[flag_i].strip()
                name = row[name_i].strip()
                platform = row[plat_i].strip()
                platform_uid = row[uid_i].strip()

                if flag != "1":
                    result["skipped"] += 1
                    continue
                if not name or not platform or not platform_uid:
                    result["errors"].append(f"第 {line_no} 行信息不完整")
                    continue

                # 去重
                key = (platform, platform_uid)
                if key in existing_accounts:
                    result["skipped"] += 1
                    continue

                # 找或建 VTuber
                vtuber = existing_vtubers.get(name)
                if not vtuber:
                    vtuber = VTuber(name=name)
                    db.add(vtuber)
                    db.flush()
                    existing_vtubers[name] = vtuber

                # 建 Account
                acc = Account(
                    vtuber_id=vtuber.id,
                    platform=platform,
                    platform_uid=platform_uid,
                    display_name=name,
                )
                db.add(acc)
                existing_accounts[key] = acc
                result["created"] += 1

        db.commit()
        logger.info(f"导入完成: 新增 {result['created']}, 跳过 {result['skipped']}")
    except Exception as e:
        logger.error(f"导入失败: {e}", exc_info=True)
        db.rollback()
        result["errors"].append(str(e))
    finally:
        if own_session:
            db.close()

    return result
