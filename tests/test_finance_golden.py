"""The TypeScript finance tests read vectors that this reference must still produce."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "finance_golden_vectors.py"
VECTORS = ROOT / "web" / "src" / "finance" / "golden-vectors.json"


def _reference() -> ModuleType:
    spec = importlib.util.spec_from_file_location("finance_golden_vectors", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_golden_vectors_are_current() -> None:
    reference = _reference()
    stored = json.loads(VECTORS.read_text())
    # Through JSON, as main() writes them.
    assert json.loads(json.dumps(reference.vectors())) == stored["cases"]
    assert json.loads(json.dumps(reference.monthly_vectors())) == stored["monthly"]
