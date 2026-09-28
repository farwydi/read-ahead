#!/usr/bin/env python3
"""Один архив для Chrome и Firefox, без npm и сборщика."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
version = json.loads((ROOT / "manifest.json").read_text())["version"]
output = ROOT / "dist" / f"read-ahead-{version}.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in ("manifest.json", "background.js", "text.js", "content.js", "page.css", "icon.png", "README.md"):
        archive.write(ROOT / name, name)
print(output)
