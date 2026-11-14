#!/usr/bin/env python3
"""Activate the already licensed DIN Next Arabic WOFF2 in the GitHub Pages site.

Run locally from the repository root:
  python scripts/activate-licensed-din-webfonts.py REGULAR.ttf MEDIUM.ttf BOLD.ttf

Requirements:
  python -m pip install fonttools brotli
  GitHub CLI installed and authenticated (gh auth login)
  Admin access to SulaimanAlsanani/techstar-erp

Font files and secrets stay on the operator's device. The script NEVER prints
secret values or commits proprietary font data to the public repository.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO = "SulaimanAlsanani/techstar-erp"
KEYS = [
    "TECHSTAR_DIN_REGULAR_WOFF2_B64",
    "TECHSTAR_DIN_MEDIUM_WOFF2_B64",
    "TECHSTAR_DIN_BOLD_WOFF2_B64",
]
ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / ".private-font-secrets"


def run(args: list[str], *, input_text: str | None = None) -> None:
    result = subprocess.run(
        args, cwd=ROOT, input=input_text, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    if result.returncode:
        # Never print stdout/stderr from an operation receiving font secrets.
        raise RuntimeError(f"Command failed (exit {result.returncode}): {args[0]} {args[1] if len(args)>1 else ''}")


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: python scripts/activate-licensed-din-webfonts.py "
            "REGULAR.ttf MEDIUM.ttf BOLD.ttf"
        )
    if not shutil.which("gh"):
        raise SystemExit("GitHub CLI (gh) is missing. Install it and run: gh auth login")
    run(["gh", "auth", "status"])
    print("Preparing the three licensed DIN Next Arabic webfonts locally...")
    run([sys.executable, str(ROOT / "scripts/prepare-licensed-din-webfonts.py"), *sys.argv[1:]])
    for key in KEYS:
        payload_file = SECRETS / f"{key}.txt"
        payload = payload_file.read_text(encoding="ascii").strip()
        if not payload:
            raise RuntimeError(f"Empty licensed Webfont secret: {key}")
        run(["gh", "secret", "set", key, "--repo", REPO], input_text=payload)
        print(f"Configured {key} in private GitHub Actions secrets.")
    run(["gh", "workflow", "run", "deploy.yml", "--repo", REPO, "--ref", "main"])
    print("Requested deployment. Check Actions for 'Licensed DIN Next Webfonts embedded'.")
    print(f"https://github.com/{REPO}/actions/workflows/deploy.yml")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc))
