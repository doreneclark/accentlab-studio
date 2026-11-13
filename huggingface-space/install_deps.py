#!/usr/bin/env python3
"""Build the pinned Seed-VC v5 runtime for an HF Docker Space image."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

SEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8"
SEED_VC_ROOT = Path(os.environ.get("SEED_VC_ROOT", "/opt/seed-vc"))


def run(*args: str) -> None:
    print(f"Running build dependency step: {args[0]}", flush=True)
    subprocess.run(list(args), check=True)


def main() -> None:
    if not SEED_VC_ROOT.exists():
        run(
            "git",
            "clone",
            "--quiet",
            "--filter=blob:none",
            "https://github.com/Plachtaa/seed-vc.git",
            str(SEED_VC_ROOT),
        )
    run("git", "-C", str(SEED_VC_ROOT), "checkout", "--quiet", "--detach", SEED_VC_COMMIT)
    actual_commit = subprocess.check_output(
        ["git", "-C", str(SEED_VC_ROOT), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual_commit != SEED_VC_COMMIT:
        raise RuntimeError(
            f"Seed-VC checkout {actual_commit} does not match required pin {SEED_VC_COMMIT}."
        )

    upstream_requirements = SEED_VC_ROOT / "requirements.txt"
    if not upstream_requirements.is_file():
        raise FileNotFoundError("The pinned Seed-VC requirements file is missing.")
    upstream = upstream_requirements.read_text(encoding="utf-8").splitlines()
    filtered = [
        line
        for line in upstream
        if not line.startswith(
            (
                "torch ",
                "torch==",
                "torchvision ",
                "torchvision==",
                "torchaudio ",
                "torchaudio==",
            )
        )
        and not line.strip().lower().startswith(
            (
                "scipy",
                "numpy",
                "descript-audio-codec",
                "freesimplegui",
                "sounddevice",
                "resemblyzer",
                "jiwer",
            )
        )
    ]
    filtered.extend(["numpy==2.1.3", "scipy==1.14.1"])
    requirements_path = Path("/tmp/accentlab-seedvc-requirements.txt")
    requirements_path.write_text("\n".join(filtered) + "\n", encoding="utf-8")

    audio_tools_runtime = [
        "argbind>=0.3.7",
        "pyloudnorm",
        "importlib-resources",
        "julius",
        "ffmpy",
        "rich",
        "matplotlib",
        "pystoi",
        "torch-stoi",
        "flatten-dict",
        "markdown2",
        "randomname",
        "tensorboard",
        "tqdm",
        "ipython",
    ]
    run(
        sys.executable,
        "-m",
        "pip",
        "install",
        "--no-cache-dir",
        "-r",
        str(requirements_path),
        "edge-tts",
        "requests",
        "faster-whisper==1.1.1",
        "protobuf==6.31.1",
        *audio_tools_runtime,
    )
    # descript-audiotools has stale protobuf metadata; preserve the tested
    # runtime pins exactly as the existing Colab bootstrap does.
    run(
        sys.executable,
        "-m",
        "pip",
        "install",
        "--no-cache-dir",
        "--no-deps",
        "descript-audiotools==0.7.2",
        "descript-audio-codec==1.0.0",
    )
    run(
        sys.executable,
        "-m",
        "pip",
        "install",
        "--no-cache-dir",
        "--no-deps",
        "numpy==2.1.3",
        "scipy==1.14.1",
        "protobuf==6.31.1",
    )
    print(
        f"HF image dependencies installed for Seed-VC commit {SEED_VC_COMMIT}.",
        flush=True,
    )


if __name__ == "__main__":
    main()
