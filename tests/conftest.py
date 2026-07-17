"""Test bootstrap.

Adds the repo root (for ``import babypool``) and the ``scripts/`` directory
(so ``import build_entries`` works — it's a standalone script, not a package)
to ``sys.path``. Keeps the test files free of per-module path juggling.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for p in (ROOT, ROOT / "scripts"):
    sp = str(p)
    if sp not in sys.path:
        sys.path.insert(0, sp)
