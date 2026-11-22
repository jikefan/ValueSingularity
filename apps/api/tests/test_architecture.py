"""Backend architectural boundary and OpenAPI sync guardrails."""

from __future__ import annotations

import ast
from pathlib import Path

from app.openapi_export import render_openapi_json

API_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = API_ROOT / "app"
REPO_ROOT = API_ROOT.parent.parent
ROUTE_DECORATOR_METHODS = frozenset(
    {"get", "post", "put", "patch", "delete", "options", "head", "api_route"}
)


def _is_route_decorator(decorator: ast.expr) -> bool:
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    return (
        isinstance(target, ast.Attribute)
        and isinstance(target.value, ast.Name)
        and target.value.id == "router"
        and target.attr in ROUTE_DECORATOR_METHODS
    )


def _assert_public_methods_are_async(paths: list[Path]) -> None:
    violations: list[str] = []
    for file_path in paths:
        tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
        rel = file_path.relative_to(API_ROOT)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            for item in node.body:
                if (
                    isinstance(item, ast.FunctionDef)
                    and item.name != "__init__"
                    and not item.name.startswith("_")
                ):
                    violations.append(
                        f"{rel}:{item.lineno}: {node.name}.{item.name} must be async def"
                    )

    assert not violations, "\n".join(violations)


def _imported_modules(file_path: Path) -> set[str]:
    tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
    package_parts = list(file_path.relative_to(API_ROOT).with_suffix("").parts[:-1])
    modules: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level > 0:
                trim = node.level - 1
                base_parts = package_parts[: len(package_parts) - trim] if trim else package_parts
                base = ".".join(base_parts)
                target = f"{base}.{node.module}" if base and node.module else (base or node.module)
            else:
                target = node.module

            if target:
                modules.add(target)
                for alias in node.names:
                    if alias.name != "*":
                        modules.add(f"{target}.{alias.name}")

    return modules


def _assert_no_forbidden_imports(subdir: str, forbidden: tuple[str, ...]) -> None:
    violations: list[str] = []
    for file_path in sorted((APP_ROOT / subdir).rglob("*.py")):
        for module in sorted(_imported_modules(file_path)):
            if any(module == prefix or module.startswith(f"{prefix}.") for prefix in forbidden):
                rel = file_path.relative_to(API_ROOT)
                violations.append(f"{rel}: forbidden import '{module}'")

    assert not violations, "\n".join(violations)


def test_legacy_repositories_directory_removed() -> None:
    assert not (APP_ROOT / "repositories").exists()


def test_domain_layer_isolation() -> None:
    _assert_no_forbidden_imports(
        "domain",
        (
            "app.adapters",
            "app.db",
            "app.services",
            "app.api",
            "sqlalchemy",
            "fastapi",
            "akshare",
            "jwt",
            "pyjwt",
            "argon2",
            "pwdlib",
        ),
    )


def test_services_layer_isolation() -> None:
    _assert_no_forbidden_imports(
        "services",
        (
            "app.adapters",
            "app.db",
            "app.api",
            "sqlalchemy",
            "fastapi",
            "akshare",
            "jwt",
            "pyjwt",
            "argon2",
            "pwdlib",
        ),
    )


def test_api_routes_layer_isolation() -> None:
    _assert_no_forbidden_imports(
        "api/routes",
        ("app.adapters", "app.db", "sqlalchemy", "jwt", "pyjwt", "argon2", "passlib", "pwdlib"),
    )


def test_adapters_layer_isolation() -> None:
    _assert_no_forbidden_imports(
        "adapters",
        ("app.services", "app.api"),
    )


def test_openapi_schema_is_in_sync() -> None:
    schema_path = REPO_ROOT / "apps/web/openapi.json"
    assert schema_path.exists(), "apps/web/openapi.json 缺失，请在仓库根目录运行 make gen-api"
    assert schema_path.read_text(encoding="utf-8") == render_openapi_json()


def test_all_routes_are_async() -> None:
    violations: list[str] = []
    for file_path in sorted((APP_ROOT / "api/routes").rglob("*.py")):
        tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
        rel = file_path.relative_to(API_ROOT)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and any(
                _is_route_decorator(dec) for dec in node.decorator_list
            ):
                violations.append(f"{rel}:{node.lineno}: route '{node.name}' must be async def")

    assert not violations, "\n".join(violations)


def test_ports_and_services_are_async() -> None:
    paths = [
        APP_ROOT / "domain/ports.py",
        *sorted((APP_ROOT / "services").rglob("*.py")),
    ]
    _assert_public_methods_are_async(paths)


def test_postgres_adapters_are_async() -> None:
    _assert_public_methods_are_async(sorted((APP_ROOT / "adapters/postgres").rglob("*.py")))


def test_no_sync_db_or_testclient_regressions() -> None:
    violations: list[str] = []
    test_paths = sorted((API_ROOT / "tests").rglob("*.py"))
    sync_db_paths = [
        APP_ROOT / "db/session.py",
        *sorted((APP_ROOT / "api").rglob("*.py")),
        *sorted((APP_ROOT / "adapters").rglob("*.py")),
        *test_paths,
    ]
    forbidden_sync_leaves = {"create_engine", "sessionmaker"}

    for file_path in sync_db_paths:
        rel = file_path.relative_to(API_ROOT)
        for module in sorted(_imported_modules(file_path)):
            leaf = module.rsplit(".", 1)[-1]
            if leaf in forbidden_sync_leaves or (
                module.startswith("sqlalchemy.") and leaf == "Session"
            ):
                violations.append(f"{rel}: forbidden sync SQLAlchemy import '{module}'")

    for file_path in test_paths:
        rel = file_path.relative_to(API_ROOT)
        for module in sorted(_imported_modules(file_path)):
            leaf = module.rsplit(".", 1)[-1]
            if module in {"fastapi.testclient", "starlette.testclient"} or leaf == "TestClient":
                violations.append(f"{rel}: forbidden TestClient import '{module}'")

    assert not violations, "\n".join(violations)
