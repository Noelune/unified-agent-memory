from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
TESTS = CORE / "tests"
for path in (CORE, TESTS):
    sys.path.insert(0, str(path))


def main() -> int:
    suite = unittest.defaultTestLoader.discover(
        start_dir=str(TESTS),
        pattern="test*.py",
        top_level_dir=str(TESTS),
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
