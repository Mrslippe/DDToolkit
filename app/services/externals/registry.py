"""外部数据源注册表（沿用 platforms registry 的按名发现模式）。"""
from app.services.externals.base import ExternalSource

_REGISTRY: dict[str, ExternalSource] = {}


def register_external_source(source: ExternalSource) -> None:
    if source.name in _REGISTRY:
        raise ValueError(f"外部数据源重复注册: {source.name}")
    _REGISTRY[source.name] = source


def get_external_source(name: str) -> ExternalSource | None:
    return _REGISTRY.get(name)


def iter_external_sources() -> list[ExternalSource]:
    return list(_REGISTRY.values())
