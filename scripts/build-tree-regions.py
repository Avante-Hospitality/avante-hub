"""Builds tree-regions.json from netlify/edge-functions/lib/tree-data.js.

tree-regions.json is what explore-tree.html draws (region shapes, province
borders, tree rules); lib/tree-data.js is the copy the edge functions place
pins with. Both come from the approved location tree. This script makes the
map file from the server file, so the two can't drift apart. It never
changes the data.

    python3 scripts/build-tree-regions.py          write tree-regions.json
    python3 scripts/build-tree-regions.py --check  only check it's up to date
                                                   (exit code 1 when it isn't)

Run it after lib/tree-data.js is regenerated. Python 3 standard library only
(Python, not Node: lib/tree-data.js was written by Python's json module, and
only Python writes its numbers back exactly as they are, e.g. -34.0).
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "netlify" / "edge-functions" / "lib" / "tree-data.js"
TARGET = ROOT / "tree-regions.json"


def build():
    src = SOURCE.read_text(encoding="utf-8")
    marker = "export default"
    if marker not in src:
        raise SystemExit(str(SOURCE) + ' has no "export default" — not the expected generated file.')
    tree = json.loads(src[src.index(marker) + len(marker):].strip().rstrip(";"))
    overlay = set(tree.get("overlay") or [])
    out = {
        "regions": [{"name": n, "overlay": n in overlay} for n in tree["shapes"]],
        "shapes": tree["shapes"],
        "provs": tree["provs"],
        "provt": tree["provt"],
        "rules": tree["rules"],
    }
    return json.dumps(out, separators=(",", ":"))


def main():
    text = build()
    if "--check" in sys.argv:
        same = TARGET.read_text(encoding="utf-8").strip() == text
        print("tree-regions.json is up to date." if same else "tree-regions.json is out of date: run python3 scripts/build-tree-regions.py")
        sys.exit(0 if same else 1)
    TARGET.write_text(text, encoding="utf-8")
    print("Wrote tree-regions.json.")


if __name__ == "__main__":
    main()
