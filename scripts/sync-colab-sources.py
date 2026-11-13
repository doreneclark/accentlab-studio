#!/usr/bin/env python3
"""Synchronize the notebook and managed Colab bootstrap from canonical sources.

Run `python3 scripts/sync-colab-sources.py` after changing a backend source.
Use `--check` in CI or before publishing to detect drift without writing files.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK_PATH = ROOT / "colab/accentlab_seedvc_backend.ipynb"
PUBLIC_NOTEBOOK_PATH = ROOT / "client/public/accentlab_seedvc_backend.ipynb"
WORKER_PATH = ROOT / "colab/api_bootstrap_worker.py"
BOOTSTRAP_PATH = ROOT / "server/colab-bootstrap.ts"
BACKEND_PATH = ROOT / "colab/accentlab_seedvc_backend.py"
NOTEBOOK_GUIDANCE = """# AccentLab Studio — expressive text-safe voice conversion

This is an experimental, temporary backend for the AccentLab Studio two-reference workflow. It uses the pinned Seed-VC upstream v2 model on a free Colab T4. The application pipeline is currently `identity-anchored-v5-expressive-text-safe`: it preserves the existing v3 two-pass, chunked, text-verified baseline and v4 expression cues, and makes laugh/giggle samples optional. The old “v2 trial” label in historical notes referred to an unverified three-pass AccentLab experiment, not the upstream model version. Do not treat any setting or version name as an 85–95% similarity score.

Write the exact spoken words, then place cues where you want a delivery change. `[mood:neutral]`, `[mood:playful]`, `[mood:excited]`, `[mood:sad]`, and `[mood:calm]` set the mood for following speech until the next mood cue. These use small Edge-TTS pitch/rate adjustments on a temporary scaffold; they are approximate, not named-emotion synthesis. Write your own jokes; the system does not create jokes or guess when a line should be funny.

`[laugh]` and `[giggle]` insert the supplied short laugh/giggle clip from the original speaker when provided; the sample is optional, and a cue is skipped if no clip is supplied. `[sob]` requires that speaker's supplied cry/sob clip. Event clips are reused, not generated or claimed as new cloned sounds. Use only files for which the speaker has given permission. Event samples are capped to eight seconds, and the spoken words—not those non-verbal clips—are checked by Pronunciation Guard.

The `/status` response includes the required pipeline version. `/generate` takes seven inputs in order: original voice filepath, French-accent reference filepath, script with cues (maximum 1,200 characters), access code, permission confirmation, optional laugh/giggle filepath, and optional cry/sob filepath. Unused optional samples should be `None`. Older notebooks are rejected by the website until updated.

In Colab, select **Runtime → Change runtime type → T4 GPU**. Run only the installation cell. After it completes, restart the session once to load the compatible packages. Reconnect to T4, run the GPU/import check, then run the backend launch cell. Do not run all cells before completing the restart. Keep the temporary share URL and random access code private. The share URL is public to anyone who obtains it while the runtime is alive.

References, the event samples used by cues, and generated files are processed through Gradio in the temporary Colab runtime. The script is also sent to Microsoft Edge-TTS to create the temporary scaffold. A runtime/job disconnect loses this in-memory take; the app cannot resume at a prior chunk, and retrying starts from the beginning. Free Colab may terminate web-UI content-generation workloads; do not add keepalive or auto-restart workarounds. Do not use sensitive material. Identity, accent, naturalness and likeness are not guaranteed; a real-speaker listening comparison has not been completed.
"""


def assignment_node(source: str, name: str) -> ast.Assign:
    tree = ast.parse(source)
    matches = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one `{name}` assignment; found {len(matches)}")
    return matches[0]


def replace_assignment(source: str, name: str, value: str) -> str:
    node = assignment_node(source, name)
    lines = source.splitlines(keepends=True)
    start = node.lineno - 1
    end = node.end_lineno or node.lineno
    current = lines[start]
    indent = current[: len(current) - len(current.lstrip())]
    replacement = f"{indent}{name} = {value!r}\n"
    lines[start:end] = [replacement]
    return "".join(lines)


def replace_typescript_export(source: str, name: str, value: str) -> str:
    match = re.search(rf"(?m)^export const {re.escape(name)} =", source)
    if not match:
        raise RuntimeError(f"Missing TypeScript export for {name}")
    quote: str | None = None
    escaped = False
    end = None
    for index in range(match.end(), len(source)):
        character = source[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
        elif character in ('"', "'", "`"):
            quote = character
        elif character == ";":
            end = index + 1
            break
    if end is None:
        raise RuntimeError(f"Could not locate the end of TypeScript export {name}")
    replacement = f"export const {name} = {json.dumps(value, ensure_ascii=False)};"
    return source[: match.start()] + replacement + source[end:]


def code_source(cell: dict[str, Any]) -> str:
    source = cell.get("source", [])
    if not isinstance(source, list) or not all(isinstance(line, str) for line in source):
        raise RuntimeError("Notebook code-cell source has an unexpected shape")
    return "".join(source)


def build_artifacts() -> dict[Path, str]:
    notebook = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
    markdown_cells = [cell for cell in notebook["cells"] if cell.get("cell_type") == "markdown"]
    if len(markdown_cells) != 1:
        raise RuntimeError(f"Expected one notebook markdown cell, found {len(markdown_cells)}")
    markdown_cells[0]["source"] = NOTEBOOK_GUIDANCE.splitlines(keepends=True)
    code_cells = [cell for cell in notebook["cells"] if cell.get("cell_type") == "code"]
    if len(code_cells) != 3:
        raise RuntimeError(f"Expected 3 notebook code cells, found {len(code_cells)}")
    install_source = code_source(code_cells[0])
    preflight_source = code_source(code_cells[1])
    backend_source = BACKEND_PATH.read_text(encoding="utf-8")

    backend_cell_text = replace_assignment(
        code_source(code_cells[2]), "backend_source", backend_source
    )
    code_cells[2]["source"] = backend_cell_text.splitlines(keepends=True)
    if notebook.get("metadata", {}).get("colab") is not None:
        notebook["metadata"]["colab"]["name"] = (
            "AccentLab Studio — v5 expressive text-safe pipeline"
        )

    worker = WORKER_PATH.read_text(encoding="utf-8")
    worker = replace_assignment(worker, "BACKEND_SOURCE", backend_source)

    bootstrap_source = BOOTSTRAP_PATH.read_text(encoding="utf-8")
    embedded = {
        "BOOTSTRAP_CANONICAL_INSTALL_SOURCE": install_source,
        "BOOTSTRAP_CANONICAL_PREFLIGHT_SOURCE": preflight_source,
        "BOOTSTRAP_CANONICAL_BACKEND_SOURCE": backend_source,
        "BOOTSTRAP_WORKER_SOURCE": worker,
    }
    for name, value in embedded.items():
        bootstrap_source = replace_typescript_export(bootstrap_source, name, value)

    notebook_text = json.dumps(notebook, ensure_ascii=False, indent=1) + "\n"
    return {
        NOTEBOOK_PATH: notebook_text,
        PUBLIC_NOTEBOOK_PATH: notebook_text,
        WORKER_PATH: worker,
        BOOTSTRAP_PATH: bootstrap_source,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if synchronized files are stale")
    args = parser.parse_args()
    artifacts = build_artifacts()
    stale = [path for path, content in artifacts.items() if path.read_text(encoding="utf-8") != content]
    if args.check:
        if stale:
            print("Colab artifacts out of sync:")
            for path in stale:
                print(f" - {path.relative_to(ROOT)}")
            return 1
        print("Colab notebook, worker, and bootstrap are synchronized.")
        return 0
    for path, content in artifacts.items():
        path.write_text(content, encoding="utf-8")
    print("Synchronized notebook, worker, and managed bootstrap from canonical sources.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
