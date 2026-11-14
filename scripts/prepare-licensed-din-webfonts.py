#!/usr/bin/env python3
"""Prepare licensed DIN Next Arabic fonts for GitHub Actions secrets.

Requires: python -m pip install fonttools brotli
Run: python scripts/prepare-licensed-din-webfonts.py REGULAR.ttf MEDIUM.ttf BOLD.ttf

No font data is printed to the terminal or committed to the repository.
Confirm that your font license allows hosted, public Webfont use.
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

SECRETS = (
    ("regular", "TECHSTAR_DIN_REGULAR_WOFF2_B64", 400),
    ("medium", "TECHSTAR_DIN_MEDIUM_WOFF2_B64", 500),
    ("bold", "TECHSTAR_DIN_BOLD_WOFF2_B64", 700),
)
# Arabic, extended Arabic, Latin Basic and common website punctuation.
UNICODES = (
    list(range(0x0020, 0x007F))
    + list(range(0x0600, 0x0700))
    + list(range(0x0750, 0x0780))
    + list(range(0x08A0, 0x0900))
    + [0x200C, 0x200D, 0x200E, 0x200F, 0x2013, 0x2014, 0x2018,
       0x2019, 0x2026, 0x20AC, 0x2122, 0x2212, 0x2713]
)
SECRET_MAX_BYTES = 48000
OUT = Path(".private-font-secrets")


def prepare(src: Path, kind: str, secret_name: str, expected_weight: int) -> None:
    font = TTFont(src)
    actual_weight = font["OS/2"].usWeightClass
    if actual_weight != expected_weight:
        raise ValueError(f"{src}: expected weight {expected_weight}, got {actual_weight}")
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]  # Retain Arabic substitutions/ligature shaping.
    options.name_IDs = [1, 2, 4, 6]
    options.name_legacy = False
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    font.flavor = "woff2"
    OUT.mkdir(mode=0o700, parents=True, exist_ok=True)
    file_path = OUT / f"din-next-{kind}.woff2"
    font.save(file_path)
    # Verify the output was written as a valid WOFF2 and preserved Arabic.
    check = TTFont(file_path)
    if check.flavor != "woff2" or 0x0645 not in check.getBestCmap():
        raise ValueError(f"WOFF2 validation failed for {kind}")
    encoded = base64.b64encode(file_path.read_bytes()).decode("ascii")
    if len(encoded) > SECRET_MAX_BYTES:
        raise ValueError(
            f"{kind}: encoded WOFF2 is too large for a GitHub Action secret ({len(encoded)} bytes)"
        )
    secret_file = OUT / f"{secret_name}.txt"
    secret_file.write_text(encoded, encoding="ascii")
    secret_file.chmod(0o600)
    print(f"{secret_name}: ready, {len(encoded)} base64 characters, stored in {secret_file}")


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: python scripts/prepare-licensed-din-webfonts.py "
            "REGULAR.ttf MEDIUM.ttf BOLD.ttf"
        )
    for path, (kind, secret_name, weight) in zip(sys.argv[1:], SECRETS):
        source = Path(path)
        if not source.is_file():
            raise SystemExit(f"Font file does not exist: {source}")
        prepare(source, kind, secret_name, weight)
    print(
        "Add the values from the three .txt files to GitHub repository Actions secrets. "
        "Do not upload the files to a public repository."
    )


if __name__ == "__main__":
    main()
