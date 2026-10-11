"""@attrs.define classes are slotted: assigning an attribute that isn't a declared field raises
AttributeError at runtime. `self._ws = ws` in GeminiApiClient did exactly that on every connect,
so every avatar session ended a second after it started (the watch showed "Avatar ended").

The streamer's dependencies are heavy, so this checks the source: every `self.x = …` in an
@attrs.define class (without slots=False) must name a field declared in the class body."""

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src/avaturn_live_streamer"


def _is_slotted_attrs(cls: ast.ClassDef) -> bool:
    for dec in cls.decorator_list:
        call = dec if isinstance(dec, ast.Call) else None
        target = call.func if call else dec
        name = ast.unparse(target)
        if name not in ("attrs.define", "attr.define", "define", "attrs.frozen", "attrs.mutable"):
            continue
        if call and any(kw.arg == "slots" and isinstance(kw.value, ast.Constant) and kw.value.value is False for kw in call.keywords):
            return False
        return True
    return False


def _declared(cls: ast.ClassDef) -> set[str]:
    names: set[str] = set()
    for node in cls.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, ast.Assign):  # __slots__ additions or class constants
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
    return names


def _assigned(cls: ast.ClassDef) -> set[tuple[str, int]]:
    out: set[tuple[str, int]] = set()
    for node in ast.walk(cls):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, (ast.AnnAssign, ast.AugAssign)) else []
        for t in targets:
            for sub in ast.walk(t):
                if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == "self":
                    out.add((sub.attr, sub.lineno))
    return out


def _slotted_classes():
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and _is_slotted_attrs(node):
                yield pytest.param(path, node, id=f"{path.relative_to(SRC)}::{node.name}")


@pytest.mark.parametrize(("path", "cls"), list(_slotted_classes()))
def test_slotted_attrs_class_only_assigns_declared_fields(path, cls):
    declared = _declared(cls)
    undeclared = sorted({f"self.{name} (line {line})" for name, line in _assigned(cls) if name not in declared})
    assert not undeclared, f"{path.name} {cls.name} assigns undeclared attributes (AttributeError on a slotted attrs class): {undeclared}"


def test_gemini_client_is_checked():
    names = [p.values[1].name for p in _slotted_classes()]
    assert "GeminiApiClient" in names
