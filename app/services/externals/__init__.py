"""外部第三方数据源（P4：添加数据源并分离抓取逻辑）。

与 app/services/platforms（直连平台的实时抓取）分离：
externals 只做「第三方已固定化数据」的只读拉取 → 归一化落库，
不承担平台实时爬取；各源独立容错（一个源失败不影响其他源）。
"""
from app.services.externals.base import ExternalJob, ExternalSource  # noqa: F401
from app.services.externals.registry import (  # noqa: F401
    get_external_source,
    iter_external_sources,
    register_external_source,
)
from app.services.externals import zeroroku, danmakus, laplace  # noqa: F401
from app.services.externals.registry import (  # noqa: F401
    get_external_source,
    iter_external_sources,
    register_external_source,
)

# 注册默认数据源（幂等：模块只被 import 一次）
register_external_source(zeroroku.ZerorokuSource())
register_external_source(danmakus.DanmakusSource())
register_external_source(laplace.LaplaceSource())
