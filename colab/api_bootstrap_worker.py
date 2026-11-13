#!/usr/bin/env python3
"""Private Colab worker for AccentLab's idempotent bootstrap.

This file is embedded into the authenticated start-code by server/colab-bootstrap.ts.
It intentionally does not print child output, Gradio URLs, or access codes.
"""
from __future__ import annotations

import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import stat
import secrets
import sys
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urlparse

API_DIR = Path("/content/accentlab-api")
STATUS_PATH = API_DIR / "status.json"
LOCK_PATH = API_DIR / "bootstrap.lock"
BACKEND_PATH = API_DIR / "accentlab_seedvc_backend.py"
MANAGED_ROOT = Path("/content/accentlab-runtime")
MANAGED_SEED_VC_ROOT = MANAGED_ROOT / "seed-vc"
WORKER_BASENAME = "api_bootstrap_worker.py"
CHILD_TIMEOUT_SECONDS = 1200
SHARE_URL_TIMEOUT_SECONDS = 120
BOOTSTRAP_ATTEMPT = os.environ.get("ACCENTLAB_BOOTSTRAP_ATTEMPT", "")

_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


def _open_verified_dir(path: Path, *, create: bool = False, mode: int = 0o700) -> int:
    """Open one fixed directory without following its final path component."""
    parent_fd = os.open(str(path.parent), os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW)
    try:
        try:
            directory_fd = os.open(
                path.name,
                os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW,
                dir_fd=parent_fd,
            )
        except FileNotFoundError:
            if not create:
                raise
            os.mkdir(path.name, mode=mode, dir_fd=parent_fd)
            directory_fd = os.open(
                path.name,
                os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW,
                dir_fd=parent_fd,
            )
        if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
            os.close(directory_fd)
            raise RuntimeError("AccentLab fixed directory has an unexpected type")
        return directory_fd
    finally:
        os.close(parent_fd)


def _open_api_dir(*, create: bool = False) -> int:
    return _open_verified_dir(API_DIR, create=create)


def _open_api_file(name: str, flags: int, mode: int = 0o600) -> tuple[int, int]:
    """Open a fixed API file through a verified API directory fd."""
    directory_fd = _open_api_dir(create=True)
    try:
        file_fd = os.open(name, flags | _O_NOFOLLOW, mode, dir_fd=directory_fd)
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            os.close(file_fd)
            raise RuntimeError("AccentLab fixed file has an unexpected type")
        return directory_fd, file_fd
    except Exception:
        os.close(directory_fd)
        raise


def _write_api_text(name: str, source: str, mode: int) -> None:
    directory_fd, file_fd = _open_api_file(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        mode,
    )
    try:
        os.fchmod(file_fd, mode)
        with os.fdopen(file_fd, "w", encoding="utf-8") as output:
            output.write(source)
            output.flush()
            os.fsync(output.fileno())
        file_fd = -1
    finally:
        if file_fd != -1:
            os.close(file_fd)
        os.close(directory_fd)


def _read_api_text(name: str) -> str:
    directory_fd = _open_api_dir(create=False)
    try:
        file_fd = os.open(name, os.O_RDONLY | _O_NOFOLLOW, dir_fd=directory_fd)
        try:
            if not stat.S_ISREG(os.fstat(file_fd).st_mode):
                raise RuntimeError("AccentLab fixed file has an unexpected type")
            with os.fdopen(file_fd, "r", encoding="utf-8") as source:
                return source.read()
        except Exception:
            try:
                os.close(file_fd)
            except OSError:
                pass
            raise
    finally:
        os.close(directory_fd)

INSTALL_SOURCE = '# In Colab: select T4, run this installation cell, restart once when prompted, then run the GPU check and backend cell.\nimport os, subprocess, sys\nfrom pathlib import Path\n\ndef run(*args):\n    result = subprocess.run(list(args), capture_output=True, text=True)\n    if result.returncode:\n        print(f"Command failed: {args[0]}", flush=True)\n        if result.stdout:\n            print("STDOUT (last 12000 characters):\\n" + result.stdout[-12000:], flush=True)\n        if result.stderr:\n            print("STDERR (last 12000 characters):\\n" + result.stderr[-12000:], flush=True)\n        result.check_returncode()\n    return result\n\nroot = Path("/content/accentlab-runtime/seed-vc")\nroot.parent.mkdir(parents=True, exist_ok=True)\nif root.parent.is_symlink() or root.is_symlink():\n    raise RuntimeError("Managed AccentLab checkout path must not be a symlink.")\nmarker = root.parent / ".accentlab-managed"\nmarker_text = "accentlab-seedvc-v1\\n51383efd921027683c89e5348211d93ff12ac2a8\\n"\nif root.exists() and (not marker.is_file() or marker.read_text(encoding="utf-8") != marker_text):\n    raise RuntimeError("Managed AccentLab checkout ownership could not be verified; no files were changed.")\nif not root.exists() and marker.exists() and (marker.is_symlink() or marker.read_text(encoding="utf-8") != marker_text):\n    raise RuntimeError("Managed AccentLab ownership marker is invalid; no files were changed.")\nif not marker.exists():\n    marker.write_text(marker_text, encoding="utf-8")\n    os.chmod(marker, 0o600)\ncommit = "51383efd921027683c89e5348211d93ff12ac2a8"\nrun("apt-get", "-qq", "update")\nrun("apt-get", "-qq", "install", "-y", "ffmpeg")\nif not root.exists():\n    run("git", "clone", "--quiet", "https://github.com/Plachtaa/seed-vc.git", str(root))\nif subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True).strip():\n    raise RuntimeError("The managed Seed-VC checkout has local changes. Use a fresh Colab runtime rather than overwriting them.")\nrun("git", "-C", str(root), "checkout", "--quiet", commit)\nrequirements = (root / "requirements.txt").read_text().splitlines()\n# Keep Colab\'s CUDA torch stack; install the upstream non-torch dependencies.\n# Use NumPy/SciPy versions with Python 3.13 wheels; skip unused GUI/evaluation packages.\nfiltered = [\n    line for line in requirements\n    if not line.startswith(("torch ", "torch==", "torchvision ", "torchvision==", "torchaudio ", "torchaudio=="))\n    and not line.strip().lower().startswith(("scipy", "numpy", "descript-audio-codec", "freesimplegui", "sounddevice", "resemblyzer", "jiwer"))\n]\nfiltered.extend(["numpy==2.1.3", "scipy==1.14.1"])\nrequirements_path = Path("/content/accentlab-runtime/accentlab-requirements.txt")\nrequirements_path.write_text("\\n".join(filtered) + "\\n")\naudio_tools_runtime = [\n    "argbind>=0.3.7",\n    "pyloudnorm",\n    "importlib-resources",\n    "julius",\n    "ffmpy",\n    "rich",\n    "matplotlib",\n    "pystoi",\n    "torch-stoi",\n    "flatten-dict",\n    "markdown2",\n    "randomname",\n    "tensorboard",\n    "tqdm",\n    "ipython",\n]\nrun(\n    sys.executable, "-m", "pip", "install", "-q",\n    "-r", str(requirements_path),\n    "edge-tts", "requests", "faster-whisper==1.1.1", "protobuf==6.31.1",\n    *audio_tools_runtime,\n)\n# descript-audiotools 0.7.2 declares protobuf<3.20, conflicting with the\n# runtime_version API and Colab TensorFlow gencode 6.31.1. Its\n# Python sources do not use protobuf directly, so install both wheels without\n# resolving that stale metadata and verify their imports in the next cell.\nrun(\n    sys.executable, "-m", "pip", "install", "-q", "--no-deps",\n    "descript-audiotools==0.7.2",\n    "descript-audio-codec==1.0.0",\n)\n# Reapply ABI-sensitive pins after every extra dependency has been resolved.\nrun(\n    sys.executable, "-m", "pip", "install", "-q", "--no-deps",\n    "numpy==2.1.3", "scipy==1.14.1", "protobuf==6.31.1",\n)\nos.environ["SEED_VC_ROOT"] = str(root)\n# The official wrapper can use repository-relative configuration paths.\nos.chdir(root)\nprint("Installation complete. Restart this Colab session once, then run the GPU/import check and backend launch cell.")\n'
PREFLIGHT_SOURCE = 'from importlib.metadata import version as package_version\nimport importlib\nimport sys\nfrom pathlib import Path\n\nimport numpy\nimport scipy\nimport torch\n\nprint(f"NumPy/SciPy versions: {numpy.__version__}/{scipy.__version__}")\nprint(f"Protobuf version: {package_version(\'protobuf\')}")\nassert numpy.__version__ == "2.1.3", f"Unexpected NumPy version: {numpy.__version__}"\nassert scipy.__version__ == "1.14.1", f"Unexpected SciPy version: {scipy.__version__}"\nassert package_version("protobuf") == "6.31.1", f"Unexpected Protobuf version: {package_version(\'protobuf\')}"\nfrom google.protobuf import runtime_version\nprint("Protobuf runtime_version module: OK", flush=True)\n\nseed_vc_root = Path("/content/accentlab-runtime/seed-vc")\nif not seed_vc_root.is_dir():\n    raise FileNotFoundError("Pinned Seed-VC checkout is missing; run the installation cell first.")\nsys.path.insert(0, str(seed_vc_root))\nfor module in (\n    "transformers.models.hubert.modeling_hubert",\n    "audiotools",\n    "dac.nn.quantize",\n    "modules.v2.vc_wrapper",\n    "faster_whisper",\n):\n    print(f"Importing {module}...", flush=True)\n    importlib.import_module(module)\n    print(f"Imported {module}: OK", flush=True)\nprint("Protobuf, HuBERT, AudioTools, DAC, Seed-VC v2 wrapper, and faster-whisper imports: OK")\nprint("CUDA available:", torch.cuda.is_available())\nif torch.cuda.is_available():\n    print("GPU:", torch.cuda.get_device_name(0))\nelse:\n    print("No GPU detected. The backend will stay not-ready; select a free T4 runtime.")\n'
BACKEND_SOURCE = '"""AccentLab experimental two-reference Seed-VC v5 expressive backend.\n\nThis module runs from a pinned checkout of the official Seed-VC repository in a\nfree Google Colab T4 runtime. It is an experimental approximation, not a model-\nlevel disentangler of speaker identity and accent, and does not promise an\nidentity, naturalness, or accent improvement.\n\nThe public Gradio API is intentionally small and stable:\n\n* ``/status``: ``access_key: str`` -> JSON with ``ready``, ``gpu``,\n  ``sample_rate``, ``pipeline_version`` and ``message`` for authorized callers.\n* ``/generate``: source/accent references, tagged script, access code, consent,\n  and optional original-speaker laugh/giggle and sob samples -> an audio filepath.\n\nThe access key is generated at process launch and is never stored in this\nsource file. The caller must supply it for both endpoints.\n"""\n\nfrom __future__ import annotations\n\nimport asyncio\nimport hashlib\nimport hmac\nimport os\nimport re\nimport secrets\nimport sys\nimport tempfile\nimport threading\nimport time\nfrom pathlib import Path\nfrom typing import Any, Iterable\n\nimport edge_tts\nimport gradio as gr\nimport librosa\nimport numpy as np\nimport soundfile as sf\nimport torch\nimport yaml\n\n# The notebook sets this to the clone directory. Keeping it configurable also\n# lets the Python file be run directly after the same installation cell.\nSEED_VC_ROOT = Path(os.environ.get("SEED_VC_ROOT", "/content/seed-vc"))\nSEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8"\nPIPELINE_VERSION = "identity-anchored-v5-expressive-text-safe"\n# Preserve the current text-safe two-pass conversion settings. The upstream\n# Seed-VC model is v2; these are not a measured identity-similarity score.\nDIFFUSION_STEPS = 50\nACCENT_TO_SOURCE_SIMILARITY = 0.93\nBLENDED_PROMPT_SIMILARITY = 0.80\nSAMPLE_RATE = 22050\nMAX_SCRIPT_CHARS = 1200\nCHUNK_TARGET_CHARS = 260\nTTS_RETRIES = 3\nCHUNK_GAP_SECONDS = 0.08\nMAX_VOCALIZATION_CUES = 6\nMAX_VOCALIZATION_DECODE_SECONDS = 12.0\nMAX_VOCALIZATION_SECONDS = 8.0\nMAX_REFERENCE_DECODE_SECONDS = 30.0\nMAX_REFERENCE_SECONDS = 25.0\nREFERENCE_SILENCE_TOP_DB = 40.0\nNEAR_SILENT_PEAK = 1e-4\nEXPRESSION_CUE_PATTERN = re.compile(\n    r"\\[(mood:(?:neutral|playful|excited|sad|calm)|laugh|giggle|sob)\\]",\n    re.IGNORECASE,\n)\nMOOD_PROSODY = {\n    "neutral": {"rate": "+0%", "pitch": "+0Hz"},\n    "playful": {"rate": "+4%", "pitch": "+2Hz"},\n    "excited": {"rate": "+7%", "pitch": "+3Hz"},\n    "sad": {"rate": "-7%", "pitch": "-2Hz"},\n    "calm": {"rate": "-4%", "pitch": "-1Hz"},\n}\nOUTPUT_RETENTION_SECONDS = 60 * 60\nOUTPUT_DIR = Path(tempfile.gettempdir()) / "accentlab_outputs"\nOUTPUT_DIR.mkdir(parents=True, exist_ok=True)\n\n# The generated value is printed once at launch for the notebook owner. It is\n# intentionally not a constant in the notebook or repository.\nACCESS_KEY = secrets.token_urlsafe(18)\nACCESS_KEY_DIGEST = hashlib.sha256(ACCESS_KEY.encode("utf-8")).digest()\nprint(f"AccentLab access code (keep private): {ACCESS_KEY}")\nprint(f"Seed-VC source pin: {SEED_VC_COMMIT}")\nprint(f"AccentLab pipeline: {PIPELINE_VERSION}")\n\nMODEL: Any | None = None\nMODEL_ERROR: str | None = None\nGPU_AVAILABLE = bool(torch.cuda.is_available())\nGENERATION_LOCK = threading.Lock()\n\n\ndef _key_is_valid(access_key: Any) -> bool:\n    """Compare a submitted key without exposing the stored key."""\n    if not isinstance(access_key, str) or not access_key:\n        return False\n    candidate_digest = hashlib.sha256(access_key.encode("utf-8")).digest()\n    return hmac.compare_digest(candidate_digest, ACCESS_KEY_DIGEST)\n\n\ndef _seed_vc_import_path() -> None:\n    """Make the pinned checkout importable without changing global cwd."""\n    if not SEED_VC_ROOT.is_dir():\n        raise RuntimeError(\n            f"Pinned Seed-VC checkout is missing at {SEED_VC_ROOT}. "\n            "Run the notebook installation cell first."\n        )\n    checkout_head = os.popen(f"git -C {shlex_quote(str(SEED_VC_ROOT))} rev-parse HEAD 2>/dev/null").read().strip()\n    if checkout_head and checkout_head != SEED_VC_COMMIT:\n        raise RuntimeError(\n            f"Seed-VC checkout is {checkout_head}, expected pinned commit {SEED_VC_COMMIT}."\n        )\n    root = str(SEED_VC_ROOT)\n    if root not in sys.path:\n        sys.path.insert(0, root)\n\n\ndef shlex_quote(value: str) -> str:\n    """Small local shell-quoting helper used only for a read-only git check."""\n    import shlex\n\n    return shlex.quote(value)\n\n\ndef _load_v2_model() -> Any:\n    """Instantiate the official v2 wrapper and load its default HF weights."""\n    global MODEL, MODEL_ERROR\n    if MODEL is not None:\n        return MODEL\n    if not GPU_AVAILABLE:\n        raise RuntimeError("A CUDA GPU is required; select a free Colab T4 runtime.")\n\n    _seed_vc_import_path()\n    from hydra.utils import instantiate\n    from omegaconf import DictConfig\n\n    config_path = SEED_VC_ROOT / "configs" / "v2" / "vc_wrapper.yaml"\n    with config_path.open("r", encoding="utf-8") as config_file:\n        config = DictConfig(yaml.safe_load(config_file))\n    wrapper = instantiate(config)\n    # These are the official VoiceConversionWrapper methods from the pinned\n    # Seed-VC commit. No unsupported SeedVCWrapper.convert_voice API is used.\n    wrapper.load_checkpoints(ar_checkpoint_path=None, cfm_checkpoint_path=None)\n    device = torch.device("cuda")\n    dtype = torch.float16\n    wrapper.to(device)\n    wrapper.eval()\n    wrapper.setup_ar_caches(max_batch_size=1, max_seq_len=4096, dtype=dtype, device=device)\n    MODEL = wrapper\n    MODEL_ERROR = None\n    return wrapper\n\n\ndef initialize_runtime() -> None:\n    """Preload the model so /status can report truthful readiness."""\n    global MODEL_ERROR\n    if not GPU_AVAILABLE:\n        MODEL_ERROR = "CUDA GPU unavailable; choose Runtime > Change runtime type > T4 GPU."\n        print(f"AccentLab not ready: {MODEL_ERROR}")\n        return\n    try:\n        print("Loading Seed-VC v2 checkpoints; first launch downloads weights from Hugging Face...")\n        _load_v2_model()\n        print("AccentLab model is ready.")\n    except Exception as exc:  # Keep Gradio alive so /status can explain failure.\n        MODEL_ERROR = f"Model initialization failed: {type(exc).__name__}: {exc}"\n        print(f"AccentLab not ready: {MODEL_ERROR}")\n\n\ndef _status(access_key: str) -> dict[str, Any]:\n    """Return the health contract, without revealing unauthorized state."""\n    if not _key_is_valid(access_key):\n        return {\n            "ready": False,\n            "gpu": False,\n            "sample_rate": SAMPLE_RATE,\n            "message": "Invalid access code.",\n        }\n    if not GPU_AVAILABLE:\n        return {\n            "ready": False,\n            "gpu": False,\n            "sample_rate": SAMPLE_RATE,\n            "pipeline_version": PIPELINE_VERSION,\n            "message": "CUDA GPU unavailable; select a free Colab T4 runtime.",\n        }\n    if MODEL is None:\n        return {\n            "ready": False,\n            "gpu": True,\n            "sample_rate": SAMPLE_RATE,\n            "pipeline_version": PIPELINE_VERSION,\n            "message": MODEL_ERROR or "Seed-VC v2 is still initializing.",\n        }\n    return {\n        "ready": True,\n        "gpu": True,\n        "sample_rate": SAMPLE_RATE,\n        "pipeline_version": PIPELINE_VERSION,\n        "message": "Ready. This is an experimental identity-anchored approximation.",\n    }\n\n\n# Pronunciation Guard runs locally in the Colab runtime. It verifies each\n# generated chunk against the requested words before any final WAV is returned.\nPRONUNCIATION_GUARD_MODEL = os.environ.get("ACCENTLAB_ASR_MODEL", "tiny.en")\nPRONUNCIATION_GUARD_CACHE = Path(\n    os.environ.get("ACCENTLAB_ASR_CACHE", "/content/accentlab-model-cache")\n)\nPRONUNCIATION_MIN_CONFIDENCE = 0.35\nPRONUNCIATION_MAX_ATTEMPTS = 2\nRETRY_DIFFUSION_STEPS = 40\nRETRY_SIMILARITY = 0.65\nRETRY_REPETITION_PENALTY = 1.2\nASR_MODEL: Any | None = None\nASR_MODEL_ERROR: str | None = None\n\n\ndef _normalize_words(text: str) -> list[str]:\n    """Normalize speech text for punctuation/case-insensitive word comparison."""\n    lowered = text.casefold().replace("’", "\'")\n    return re.findall(r"[a-z0-9]+(?:\'[a-z0-9]+)?", lowered)\n\n\ndef _compare_transcript(\n    expected_text: str,\n    transcript: str,\n    confidence: float | None,\n) -> dict[str, Any]:\n    """Compare normalized words and expose actionable mismatch details."""\n    from difflib import SequenceMatcher\n\n    expected = _normalize_words(expected_text)\n    actual = _normalize_words(transcript)\n    matcher = SequenceMatcher(a=expected, b=actual, autojunk=False)\n    missing: list[str] = []\n    unexpected: list[str] = []\n    substitutions: list[dict[str, list[str]]] = []\n    for tag, start_a, end_a, start_b, end_b in matcher.get_opcodes():\n        if tag == "delete":\n            missing.extend(expected[start_a:end_a])\n        elif tag == "insert":\n            unexpected.extend(actual[start_b:end_b])\n        elif tag == "replace":\n            substitutions.append(\n                {\n                    "expected": expected[start_a:end_a],\n                    "actual": actual[start_b:end_b],\n                }\n            )\n    uncertain = confidence is None or confidence < PRONUNCIATION_MIN_CONFIDENCE\n    return {\n        "ok": bool(expected) and not uncertain and not missing and not unexpected and not substitutions,\n        "uncertain": uncertain,\n        "confidence": confidence,\n        "expected": expected,\n        "actual": actual,\n        "transcript": transcript.strip(),\n        "missing": missing,\n        "unexpected": unexpected,\n        "substitutions": substitutions,\n    }\n\n\ndef _verification_requires_retry(result: dict[str, Any]) -> bool:\n    """Retry definite word mismatches, but fail closed on uncertain ASR."""\n    return not bool(result.get("ok")) and not bool(result.get("uncertain"))\n\n\ndef _load_pronunciation_model() -> Any:\n    """Load a small local Whisper model only when the first generation needs it."""\n    global ASR_MODEL, ASR_MODEL_ERROR\n    if ASR_MODEL is not None:\n        return ASR_MODEL\n    if ASR_MODEL_ERROR:\n        raise RuntimeError(ASR_MODEL_ERROR)\n    try:\n        from faster_whisper import WhisperModel\n\n        PRONUNCIATION_GUARD_CACHE.mkdir(parents=True, exist_ok=True)\n        device = "cuda" if GPU_AVAILABLE else "cpu"\n        compute_type = "float16" if device == "cuda" else "int8"\n        ASR_MODEL = WhisperModel(\n            PRONUNCIATION_GUARD_MODEL,\n            device=device,\n            compute_type=compute_type,\n            download_root=str(PRONUNCIATION_GUARD_CACHE),\n        )\n        return ASR_MODEL\n    except Exception as exc:\n        ASR_MODEL_ERROR = (\n            "Pronunciation Guard could not load its local speech-recognition model. "\n            f"{type(exc).__name__}: {exc}"\n        )\n        raise RuntimeError(ASR_MODEL_ERROR) from exc\n\n\ndef _transcribe_audio(path: str) -> tuple[str, float | None]:\n    """Transcribe a generated chunk locally and return text plus conservative confidence."""\n    model = _load_pronunciation_model()\n    segments, _info = model.transcribe(\n        path,\n        beam_size=5,\n        vad_filter=True,\n        condition_on_previous_text=False,\n    )\n    collected = []\n    confidences = []\n    for segment in segments:\n        text = getattr(segment, "text", "")\n        if isinstance(text, str):\n            collected.append(text)\n        log_probability = getattr(segment, "avg_logprob", None)\n        if isinstance(log_probability, (int, float)):\n            # Convert Whisper\'s negative log probability to a bounded score.\n            confidences.append(max(0.0, min(1.0, float(np.exp(log_probability)))))\n    transcript = " ".join(collected).strip()\n    confidence = float(np.mean(confidences)) if confidences else None\n    return transcript, confidence\n\n\ndef _verify_chunk(path: str, expected_text: str) -> dict[str, Any]:\n    """Verify one output chunk without sending audio outside the Colab VM."""\n    transcript, confidence = _transcribe_audio(path)\n    return _compare_transcript(expected_text, transcript, confidence)\n\n\ndef _audio_duration(path: str) -> float:\n    try:\n        return float(librosa.get_duration(path=path))\n    except Exception as exc:\n        raise ValueError(f"Could not read audio file: {exc}") from exc\n\n\ndef _validate_audio(path: Any, label: str) -> str:\n    if not isinstance(path, str) or not path or not Path(path).is_file():\n        raise ValueError(f"{label} must be an uploaded audio file.")\n    if Path(path).stat().st_size > 20 * 1024 * 1024:\n        raise ValueError(f"{label} must be 20 MB or smaller after decoding.")\n    duration = _audio_duration(path)\n    if duration <= 0.0:\n        raise ValueError(f"{label} is empty.")\n    return path\n\n\ndef _parse_expression_script(script: str) -> list[dict[str, Any]]:\n    """Separate explicit mood and vocalization controls from spoken words."""\n    segments: list[dict[str, Any]] = []\n    mood = "neutral"\n    cursor = 0\n\n    def add_speech(value: str) -> None:\n        text = value.strip()\n        if text:\n            segments.append({"kind": "speech", "text": text, "mood": mood})\n\n    for match in EXPRESSION_CUE_PATTERN.finditer(script):\n        add_speech(script[cursor : match.start()])\n        cue = match.group(1).lower()\n        if cue.startswith("mood:"):\n            mood = cue.split(":", 1)[1]\n        else:\n            segments.append({"kind": "vocalization", "cue": cue})\n        cursor = match.end()\n    add_speech(script[cursor:])\n    return segments\n\n\ndef _prepare_vocalization(path: str, label: str) -> tuple[int, np.ndarray]:\n    """Decode one finite event sample, trim only edge silence, and cap its duration."""\n    wave, sample_rate = librosa.load(\n        path,\n        sr=SAMPLE_RATE,\n        mono=True,\n        duration=MAX_VOCALIZATION_DECODE_SECONDS,\n    )\n    if wave.size == 0 or not np.isfinite(wave).all():\n        raise ValueError(f"{label} contains no usable finite audio.")\n    if float(np.max(np.abs(wave))) <= NEAR_SILENT_PEAK:\n        raise ValueError(f"{label} is silent or near-silent.")\n    trimmed, _ = librosa.effects.trim(\n        wave,\n        top_db=REFERENCE_SILENCE_TOP_DB,\n        frame_length=2048,\n        hop_length=512,\n    )\n    trimmed = trimmed[: int(MAX_VOCALIZATION_SECONDS * sample_rate)]\n    if trimmed.size < int(0.15 * sample_rate) or not np.isfinite(trimmed).all():\n        raise ValueError(f"{label} is too short or unusable after preparation.")\n    if float(np.max(np.abs(trimmed))) <= NEAR_SILENT_PEAK:\n        raise ValueError(f"{label} is silent or near-silent after preparation.")\n    return SAMPLE_RATE, trimmed.astype(np.float32, copy=False)\n\n\ndef _prepare_reference(original_path: str, prepared_path: Path, label: str) -> None:\n    """Decode up to 30 seconds, trim edge silence, then retain at most 25 seconds."""\n    wave, sample_rate = librosa.load(\n        original_path,\n        sr=SAMPLE_RATE,\n        mono=True,\n        duration=MAX_REFERENCE_DECODE_SECONDS,\n    )\n    if wave.size == 0 or not np.isfinite(wave).all():\n        raise ValueError(f"{label} contains no usable finite audio.")\n    if float(np.max(np.abs(wave))) <= NEAR_SILENT_PEAK:\n        raise ValueError(f"{label} is silent or near-silent.")\n    # librosa.effects.trim only removes leading/trailing silence; internal\n    # pauses remain untouched. Do not denoise, pitch-shift, or normalize upward.\n    trimmed, _ = librosa.effects.trim(\n        wave,\n        top_db=REFERENCE_SILENCE_TOP_DB,\n        frame_length=2048,\n        hop_length=512,\n    )\n    if trimmed.size == 0 or not np.isfinite(trimmed).all():\n        raise ValueError(f"{label} contains no usable audio after edge-silence trimming.")\n    max_frames = int(MAX_REFERENCE_SECONDS * sample_rate)\n    trimmed = trimmed[:max_frames]\n    if trimmed.size == 0 or float(np.max(np.abs(trimmed))) <= NEAR_SILENT_PEAK:\n        raise ValueError(f"{label} is silent or near-silent after preparation.")\n    sf.write(prepared_path, trimmed, sample_rate, subtype="PCM_16")\n\n\nasync def _tts_to_mp3(text: str, output_path: str, mood: str) -> None:\n    # Edge TTS exposes prosody controls, not named-emotion synthesis. These\n    # small changes are experimental cues on a temporary content scaffold.\n    prosody = MOOD_PROSODY.get(mood, MOOD_PROSODY["neutral"])\n    communicate = edge_tts.Communicate(\n        text,\n        "en-US-JennyNeural",\n        rate=prosody["rate"],\n        pitch=prosody["pitch"],\n    )\n    await communicate.save(output_path)\n\n\ndef _make_neutral_speech(text: str, output_path: str, mood: str = "neutral") -> None:\n    """Create a prosody-directed scaffold, retrying transient TTS failures."""\n    last_error: Exception | None = None\n    for attempt in range(TTS_RETRIES):\n        mp3_path = f"{output_path}.attempt{attempt}.mp3"\n        try:\n            asyncio.run(_tts_to_mp3(text, mp3_path, mood))\n            from pydub import AudioSegment\n\n            AudioSegment.from_file(mp3_path, format="mp3").set_channels(1).set_frame_rate(\n                SAMPLE_RATE\n            ).export(output_path, format="wav")\n            info = sf.info(output_path)\n            if info.frames <= 0 or info.samplerate != SAMPLE_RATE:\n                raise RuntimeError("Edge TTS returned an invalid audio file.")\n            return\n        except Exception as exc:\n            last_error = exc\n            if attempt + 1 < TTS_RETRIES:\n                time.sleep(0.5 * (attempt + 1))\n        finally:\n            try:\n                Path(mp3_path).unlink()\n            except FileNotFoundError:\n                pass\n    raise RuntimeError(f"Neutral TTS failed after {TTS_RETRIES} attempts: {last_error}")\n\n\ndef _split_script(script: str) -> list[str]:\n    """Split long text at sentence/word boundaries while preserving all text."""\n    normalized = re.sub(r"\\s+", " ", script).strip()\n    if len(normalized) <= CHUNK_TARGET_CHARS:\n        return [normalized]\n    sentences = re.split(r"(?<=[.!?。！？])\\s+", normalized)\n    chunks: list[str] = []\n    current = ""\n    for sentence in sentences:\n        words = sentence.split()\n        if not words:\n            continue\n        for word in words:\n            candidate = f"{current} {word}".strip()\n            if current and len(candidate) > CHUNK_TARGET_CHARS:\n                chunks.append(current)\n                current = word\n            else:\n                current = candidate\n        if current and sentence.endswith((".", "!", "?", "。", "！", "？")):\n            chunks.append(current)\n            current = ""\n    if current:\n        chunks.append(current)\n    return chunks or [normalized]\n\n\ndef _join_audio_chunks(chunks: list[tuple[int, np.ndarray]]) -> tuple[int, np.ndarray]:\n    """Join validated chunks with a tiny silence gap to avoid boundary clicks."""\n    if not chunks:\n        raise RuntimeError("No converted audio chunks were produced.")\n    sample_rate = chunks[0][0]\n    if any(rate != sample_rate for rate, _ in chunks):\n        raise RuntimeError("Converted chunks used inconsistent sample rates.")\n    gap = np.zeros(max(1, int(sample_rate * CHUNK_GAP_SECONDS)), dtype=np.float32)\n    pieces: list[np.ndarray] = []\n    for index, (_, audio) in enumerate(chunks):\n        if index:\n            pieces.append(gap)\n        pieces.append(np.asarray(audio, dtype=np.float32).squeeze())\n    return sample_rate, np.concatenate(pieces)\n\n\ndef _collect_final_audio(outputs: Iterable[Any]) -> tuple[int, np.ndarray]:\n    """Collect and validate the final ``(sample_rate, ndarray)`` result."""\n    final_audio: Any = None\n    for item in outputs:\n        if not isinstance(item, tuple) or len(item) != 2:\n            continue\n        _, full_audio = item\n        if full_audio is not None:\n            final_audio = full_audio\n    if not isinstance(final_audio, tuple) or len(final_audio) != 2:\n        raise RuntimeError("Seed-VC returned no complete audio result.")\n    sample_rate, audio = final_audio\n    audio_array = np.asarray(audio).squeeze()\n    if audio_array.size == 0 or not np.isfinite(audio_array).all():\n        raise RuntimeError("Seed-VC returned empty or non-finite audio.")\n    return int(sample_rate), audio_array.astype(np.float32, copy=False)\n\n\ndef _safe_wav_audio(audio: np.ndarray) -> np.ndarray:\n    """Scale peaks above 0.95 proportionally; never hard-clip or raise quiet audio."""\n    audio_array = np.asarray(audio, dtype=np.float32).squeeze()\n    if audio_array.size == 0 or not np.isfinite(audio_array).all():\n        raise RuntimeError("Audio output is empty or non-finite.")\n    peak = float(np.max(np.abs(audio_array)))\n    if peak > 0.95:\n        audio_array = audio_array * (0.95 / peak)\n    return audio_array\n\n\ndef _write_safe_wav(path: Path, audio: np.ndarray, sample_rate: int) -> None:\n    sf.write(path, _safe_wav_audio(audio), sample_rate, subtype="PCM_16")\n    sf.info(path)\n\n\ndef _convert_once(\n    model: Any,\n    source_path: str,\n    target_path: str,\n    *,\n    convert_style: bool,\n    similarity_cfg_rate: float,\n    diffusion_steps: int = DIFFUSION_STEPS,\n    repetition_penalty: float = 1.5,\n) -> tuple[int, np.ndarray]:\n    """Run one official v2 conversion with identity/style-specific guidance."""\n    device = torch.device("cuda")\n    outputs = model.convert_voice_with_streaming(\n        source_audio_path=source_path,\n        target_audio_path=target_path,\n        diffusion_steps=diffusion_steps,\n        length_adjust=1.0,\n        # The spelling below is part of the pinned upstream API.\n        intelligebility_cfg_rate=0.7,\n        similarity_cfg_rate=similarity_cfg_rate,\n        top_p=0.7,\n        temperature=0.7,\n        repetition_penalty=repetition_penalty,\n        convert_style=convert_style,\n        anonymization_only=False,\n        device=device,\n        dtype=torch.float16,\n        stream_output=True,\n    )\n    return _collect_final_audio(outputs)\n\n\ndef _cleanup_old_outputs() -> None:\n    """Bounded retention cleanup; never recursively removes Gradio directories."""\n    cutoff = time.time() - OUTPUT_RETENTION_SECONDS\n    for candidate in list(OUTPUT_DIR.glob("accentlab_*.wav"))[:256]:\n        try:\n            if candidate.stat().st_mtime < cutoff:\n                candidate.unlink()\n        except FileNotFoundError:\n            continue\n        except OSError:\n            continue\n\n\ndef _generate(\n    source_voice: str,\n    accent_reference: str,\n    script: str,\n    access_key: str,\n    consent: bool,\n    laugh_sample: str | None = None,\n    sob_sample: str | None = None,\n    progress=gr.Progress(),\n) -> str:\n    """Generate verified speech and insert explicitly requested speaker samples."""\n    # Authenticate before touching the model or starting any GPU conversion.\n    if not _key_is_valid(access_key):\n        raise gr.Error("Invalid access code.")\n    if not GPU_AVAILABLE:\n        raise gr.Error("CUDA GPU unavailable; select a free Colab T4 runtime.")\n    if MODEL is None:\n        raise gr.Error(MODEL_ERROR or "Seed-VC v2 is not ready yet.")\n    if consent is not True:\n        raise gr.Error(\n            "Confirm permission for both references and any original-speaker vocalization samples."\n        )\n    if not isinstance(script, str) or not script.strip():\n        raise gr.Error("Enter spoken words or an explicit vocalization cue.")\n    if len(script) > MAX_SCRIPT_CHARS:\n        raise gr.Error(f"Text is limited to {MAX_SCRIPT_CHARS} characters.")\n\n    script_segments = _parse_expression_script(script)\n    if not script_segments:\n        raise gr.Error("Enter spoken words or an explicit vocalization cue.")\n    vocalization_cues = [\n        segment["cue"]\n        for segment in script_segments\n        if segment["kind"] == "vocalization"\n    ]\n    if len(vocalization_cues) > MAX_VOCALIZATION_CUES:\n        raise gr.Error(\n            f"Use no more than {MAX_VOCALIZATION_CUES} laugh, giggle, or sob cues per take."\n        )\n    has_laugh_cue = any(cue in ("laugh", "giggle") for cue in vocalization_cues)\n    needs_sob_sample = "sob" in vocalization_cues\n    has_speech = any(segment["kind"] == "speech" for segment in script_segments)\n    if not has_speech and not vocalization_cues:\n        raise gr.Error("Enter spoken words or an explicit vocalization cue.")\n    if needs_sob_sample and not sob_sample:\n        raise gr.Error("Add the original speaker\'s cry/sob sample for this cue.")\n    has_laugh_audio = has_laugh_cue and bool(laugh_sample)\n    has_sob_audio = needs_sob_sample and bool(sob_sample)\n    if not has_speech and not (has_laugh_audio or has_sob_audio):\n        raise gr.Error(\n            "No spoken words remain after skipping optional laugh/giggle cues. "\n            "Add spoken text or provide an original-speaker sample for a vocalization-only take."\n        )\n\n    try:\n        source_path = _validate_audio(source_voice, "Original voice")\n        accent_path = _validate_audio(accent_reference, "French-accent reference")\n        if has_laugh_audio:\n            laugh_sample = _validate_audio(\n                laugh_sample, "Original-speaker laugh/giggle sample"\n            )\n        if needs_sob_sample:\n            sob_sample = _validate_audio(sob_sample, "Original-speaker cry/sob sample")\n    except ValueError as exc:\n        raise gr.Error(str(exc)) from exc\n    if not GENERATION_LOCK.acquire(blocking=False):\n        raise gr.Error("Another conversion is running; try again after it finishes.")\n\n    try:\n        _cleanup_old_outputs()\n        with tempfile.TemporaryDirectory(prefix="accentlab_") as work_dir:\n            work = Path(work_dir)\n            prepared_source = work / "source_reference.wav"\n            prepared_accent = work / "accent_reference.wav"\n            _prepare_reference(source_path, prepared_source, "Original voice")\n            _prepare_reference(accent_path, prepared_accent, "French-accent reference")\n            source_path, accent_path = str(prepared_source), str(prepared_accent)\n            blended_prompt = work / "accent_reference_in_source_voice.wav"\n            actions: list[dict[str, Any]] = []\n            for segment in script_segments:\n                if segment["kind"] == "vocalization":\n                    actions.append(segment)\n                    continue\n                for text_chunk in _split_script(segment["text"]):\n                    actions.append(\n                        {\n                            "kind": "speech",\n                            "text": text_chunk,\n                            "mood": segment["mood"],\n                        }\n                    )\n            output_chunks: list[tuple[int, np.ndarray]] = []\n            event_audio: dict[str, tuple[int, np.ndarray]] = {}\n            if has_laugh_cue and laugh_sample:\n                event_audio["laugh"] = _prepare_vocalization(\n                    laugh_sample, "Original-speaker laugh/giggle sample"\n                )\n            if needs_sob_sample and sob_sample:\n                event_audio["sob"] = _prepare_vocalization(\n                    sob_sample, "Original-speaker cry/sob sample"\n                )\n\n            progress(0.05, desc="Preparing the reference recordings and expression cues")\n\n            # Keep the text-safe two-pass baseline. A third direct-source pass\n            # is intentionally absent because it could erase requested words.\n            if has_speech:\n                progress(0.15, desc="Adapting the accent reference to the original voice")\n                stage1_sr, stage1_audio = _convert_once(\n                    MODEL,\n                    accent_path,\n                    source_path,\n                    convert_style=False,\n                    similarity_cfg_rate=ACCENT_TO_SOURCE_SIMILARITY,\n                )\n                _write_safe_wav(blended_prompt, stage1_audio, stage1_sr)\n\n            for index, action in enumerate(actions):\n                action_number = index + 1\n                if action["kind"] == "vocalization":\n                    cue = action["cue"]\n                    event_key = "laugh" if cue in ("laugh", "giggle") else "sob"\n                    if event_key not in event_audio:\n                        if event_key != "laugh":\n                            raise gr.Error(\n                                "Add the original speaker\'s cry/sob sample for this cue."\n                            )\n                        progress(\n                            0.20 + 0.65 * (action_number / len(actions)),\n                            desc=f"Skipping the {cue} cue; no optional laugh/giggle sample was supplied.",\n                        )\n                        continue\n                    output_chunks.append(event_audio[event_key])\n                    progress(\n                        0.20 + 0.65 * (action_number / len(actions)),\n                        desc=f"Inserting the original-speaker {cue} sample.",\n                    )\n                    continue\n\n                chunk = action["text"]\n                mood = action["mood"]\n                neutral_wav = work / f"mood_scaffold_{action_number}.wav"\n                stage2_wav = work / f"new_speech_{action_number}.wav"\n                _make_neutral_speech(chunk, str(neutral_wav), mood)\n                progress(\n                    0.20 + 0.65 * ((action_number - 0.5) / len(actions)),\n                    desc=f"Preparing {mood} speech segment {action_number} of {len(actions)}",\n                )\n                progress(\n                    0.20 + 0.65 * ((action_number - 1) / len(actions)),\n                    desc=f"Converting speech segment {action_number} of {len(actions)}",\n                )\n                segment_result: tuple[int, np.ndarray] | None = None\n                last_verification: dict[str, Any] | None = None\n                for attempt in range(1, PRONUNCIATION_MAX_ATTEMPTS + 1):\n                    if attempt == 1:\n                        conversion_steps = DIFFUSION_STEPS\n                        conversion_similarity = BLENDED_PROMPT_SIMILARITY\n                        conversion_repetition = 1.5\n                    else:\n                        progress(\n                            0.20 + 0.65 * ((action_number - 1) / len(actions)),\n                            desc=f"Retrying segment {action_number} because words were missing.",\n                        )\n                        conversion_steps = RETRY_DIFFUSION_STEPS\n                        conversion_similarity = RETRY_SIMILARITY\n                        conversion_repetition = RETRY_REPETITION_PENALTY\n                    stage2_sr, stage2_audio = _convert_once(\n                        MODEL,\n                        str(neutral_wav),\n                        str(blended_prompt),\n                        convert_style=True,\n                        similarity_cfg_rate=conversion_similarity,\n                        diffusion_steps=conversion_steps,\n                        repetition_penalty=conversion_repetition,\n                    )\n                    _write_safe_wav(stage2_wav, stage2_audio, stage2_sr)\n                    expected_seconds = _audio_duration(str(neutral_wav))\n                    actual_seconds = float(np.asarray(stage2_audio).shape[-1]) / float(stage2_sr)\n                    if actual_seconds < max(0.8, expected_seconds * 0.55):\n                        raise gr.Error(\n                            f"Speech segment {action_number} was much shorter than requested. "\n                            "No incomplete audio was returned; retry with shorter text."\n                        )\n                    last_verification = _verify_chunk(str(stage2_wav), chunk)\n                    if last_verification["ok"]:\n                        progress(\n                            0.20 + 0.65 * (action_number / len(actions)),\n                            desc=f"All requested words detected in segment {action_number}.",\n                        )\n                        segment_result = (stage2_sr, stage2_audio)\n                        break\n                    if last_verification["uncertain"]:\n                        raise gr.Error(\n                            f"Verification uncertain for segment {action_number}; please listen carefully. "\n                            "No unverified audio was returned."\n                        )\n                    if attempt == PRONUNCIATION_MAX_ATTEMPTS:\n                        missing = ", ".join(last_verification["missing"][:8]) or "some words"\n                        raise gr.Error(\n                            f"Could not verify segment {action_number} after {PRONUNCIATION_MAX_ATTEMPTS} attempts; "\n                            f"missing: {missing}. No unverified audio was returned."\n                        )\n                if segment_result is None:\n                    raise gr.Error(\n                        f"Could not verify segment {action_number}. No unverified audio was returned."\n                    )\n                output_chunks.append(segment_result)\n\n            output_sr, output_audio = _join_audio_chunks(output_chunks)\n            output_path = OUTPUT_DIR / f"accentlab_{secrets.token_hex(12)}.wav"\n            _write_safe_wav(output_path, output_audio, output_sr)\n            progress(1.0, desc="All speech segments verified. Expressive WAV ready")\n            return str(output_path)\n    except gr.Error:\n        raise\n    except Exception as exc:\n        raise gr.Error(f"Conversion failed: {type(exc).__name__}: {exc}") from exc\n    finally:\n        GENERATION_LOCK.release()\n\n\ndef build_demo() -> gr.Blocks:\n    """Build Blocks with the exact v4 /status and /generate API contracts."""\n    with gr.Blocks(title="AccentLab Studio — expressive text-safe") as demo:\n        gr.Markdown(\n            "## AccentLab Studio — expressive text-safe conversion\\n"\n            "Use only recordings you have permission to transform. Mood cues use "\n            "approximate rate/pitch changes. Laugh/giggle samples are optional; "\n            "without one, those cues are skipped. A [sob] cue requires a short "\n            "original-speaker cry/sob sample. Supplied clips are inserted, not "\n            "newly synthesized. Identity, naturalness and accent transfer are experimental."\n        )\n        access_key = gr.Textbox(label="Access code", type="password")\n        status_button = gr.Button("Check backend", visible=True)\n        status_output = gr.JSON(label="Backend status")\n        status_button.click(\n            _status,\n            inputs=[access_key],\n            outputs=[status_output],\n            api_name="status",\n            queue=False,\n        )\n\n        source_voice = gr.Audio(type="filepath", label="Original voice — identity guide")\n        accent_reference = gr.Audio(type="filepath", label="French-accent reference — accent/style")\n        laugh_sample = gr.Audio(\n            type="filepath", label="Optional original-speaker laugh/giggle sample"\n        )\n        sob_sample = gr.Audio(\n            type="filepath", label="Required original-speaker cry/sob sample for [sob]"\n        )\n        script = gr.Textbox(\n            lines=7,\n            max_lines=14,\n            max_length=MAX_SCRIPT_CHARS,\n            label="Script plus [mood:playful], [laugh], [giggle], or [sob] cues (maximum 1200 characters)",\n        )\n        consent = gr.Checkbox(\n            label="I have permission to transform both references and any original-speaker event samples.",\n            value=False,\n        )\n        generate_button = gr.Button("Generate", variant="primary")\n        result = gr.Audio(type="filepath", label="Converted WAV")\n        generate_button.click(\n            _generate,\n            inputs=[\n                source_voice,\n                accent_reference,\n                script,\n                access_key,\n                consent,\n                laugh_sample,\n                sob_sample,\n            ],\n            outputs=[result],\n            api_name="generate",\n        )\n        gr.Markdown(\n            "The temporary shared URL is public to anyone who has it while this "\n            "Colab session runs. References, the event samples used by cues, and "\n            "generated files are processed in the temporary runtime; do not use "\n            "sensitive recordings."\n        )\n    return demo\n\n\ninitialize_runtime()\ndemo = build_demo()\ndemo.queue(default_concurrency_limit=1)\nprint("Starting temporary Gradio URL; keep this Colab tab open while using it.")\ndemo.launch(share=True, debug=True, max_file_size="20mb")\n'

def _secure_dir() -> None:
    directory_fd = _open_api_dir(create=True)
    try:
        os.fchmod(directory_fd, 0o700)
    finally:
        os.close(directory_fd)


def _read_status() -> dict[str, object]:
    try:
        value = json.loads(_read_api_text(STATUS_PATH.name))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, OSError, RuntimeError, ValueError, TypeError):
        return {}


def _process_start_ticks(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        fields_after_comm = stat[stat.rfind(")") + 2 :].split()
        return fields_after_comm[19] if len(fields_after_comm) > 19 else None
    except (OSError, IndexError, ValueError):
        return None


def _write_status(stage: str, message: str, **extra: object) -> dict[str, object]:
    _secure_dir()
    payload: dict[str, object] = {
        "stage": stage,
        "message": message,
        "pid": os.getpid(),
        "processStartTicks": _process_start_ticks(os.getpid()),
        "updatedAt": int(time.time()),
        "attempt": BOOTSTRAP_ATTEMPT,
    }
    payload.update(extra)
    directory_fd = _open_api_dir(create=False)
    temporary_name = ""
    fd = -1
    try:
        while True:
            temporary_name = f".status-{secrets.token_hex(12)}.json"
            try:
                fd = os.open(
                    temporary_name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_NOFOLLOW,
                    0o600,
                    dir_fd=directory_fd,
                )
                break
            except FileExistsError:
                continue
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as temporary:
            json.dump(payload, temporary, separators=(",", ":"), ensure_ascii=True)
            temporary.flush()
            os.fsync(temporary.fileno())
        fd = -1
        os.replace(
            temporary_name,
            STATUS_PATH.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        status_fd = os.open(STATUS_PATH.name, os.O_RDONLY | _O_NOFOLLOW, dir_fd=directory_fd)
        try:
            os.fchmod(status_fd, 0o600)
        finally:
            os.close(status_fd)
    finally:
        if fd != -1:
            os.close(fd)
        if temporary_name:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        os.close(directory_fd)
    return payload


def _pid_is_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OSError):
        return False
    return True


def _run_child(source: str, label: str, *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    # The canonical cells are deliberately run in fresh Python children. This
    # avoids relying on imports left in an earlier Colab execution namespace.
    try:
        result = subprocess.run(
            [sys.executable, "-c", source],
            text=True,
            timeout=CHILD_TIMEOUT_SECONDS,
            check=False,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{label} timed out") from exc
    if result.returncode != 0:
        raise RuntimeError(f"{label} failed")
    return result


def _require_tesla_t4() -> None:
    probe = r"""import json
import torch
if not torch.cuda.is_available():
    raise RuntimeError("CUDA unavailable")
name = torch.cuda.get_device_name(0)
if name != "Tesla T4":
    raise RuntimeError("Unsupported GPU")
print(json.dumps({"gpu": True, "name": name}))
"""
    result = _run_child(probe, "GPU validation", capture=True)
    output = (result.stdout or "").splitlines()
    try:
        details = json.loads(output[-1])
    except (IndexError, ValueError, TypeError) as exc:
        raise RuntimeError("GPU validation failed") from exc
    if details.get("gpu") is not True or details.get("name") != "Tesla T4":
        raise RuntimeError("Unsupported GPU")


def _safe_share_url(value: object) -> str:
    if not isinstance(value, str):
        raise RuntimeError("Gradio did not provide a share URL")
    parsed = urlparse(value.strip())
    hostname = parsed.hostname or ""
    if parsed.scheme != "https" or not hostname.endswith(".gradio.live") or hostname == "gradio.live":
        raise RuntimeError("Gradio did not provide an approved HTTPS share URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError("Gradio returned an unsafe share URL")
    return value.strip().rstrip("/")


def _load_and_launch() -> tuple[str, str]:
    # Keep the exact checked-in backend source on disk, then remove only its
    # canonical initialize/build/launch tail before executing definitions.
    managed_fd = _open_verified_dir(MANAGED_ROOT, create=False)
    try:
        seed_fd = _open_verified_dir(MANAGED_SEED_VC_ROOT, create=False)
        os.close(seed_fd)
    finally:
        os.close(managed_fd)
    _write_api_text(BACKEND_PATH.name, BACKEND_SOURCE, 0o600)
    prefix, separator, _tail = BACKEND_SOURCE.partition("\n\ninitialize_runtime()\n")
    if not separator:
        raise RuntimeError("Canonical backend launch tail was not found")

    # Setup runs in a child, so its cwd does not carry into this model process.
    # The pinned wrapper reads repository-relative configs when constructed.
    managed_seed_vc_root = "/content/accentlab-runtime/seed-vc"
    os.environ["SEED_VC_ROOT"] = managed_seed_vc_root
    os.chdir(managed_seed_vc_root)
    namespace: dict[str, Any] = {
        "__name__": "accentlab_seedvc_backend",
        "__file__": str(BACKEND_PATH),
    }
    quiet_stdout = io.StringIO()
    quiet_stderr = io.StringIO()
    with contextlib.redirect_stdout(quiet_stdout), contextlib.redirect_stderr(quiet_stderr):
        exec(compile(prefix, str(BACKEND_PATH), "exec"), namespace, namespace)
        initialize_runtime = namespace.get("initialize_runtime")
        if not callable(initialize_runtime):
            raise RuntimeError("Canonical backend initializer missing")
        initialize_runtime()
        gpu_available = namespace.get("GPU_AVAILABLE")
        model = namespace.get("MODEL")
        if gpu_available is not True or model is None:
            raise RuntimeError("Seed-VC model is not ready on the validated T4")
        build_demo = namespace.get("build_demo")
        if not callable(build_demo):
            raise RuntimeError("Canonical backend demo builder missing")
        demo: Any = build_demo()
        demo.queue(default_concurrency_limit=1)
        demo.launch(
            share=True,
            debug=False,
            prevent_thread_lock=True,
            max_file_size="20mb",
        )

        endpoint = ""
        deadline = time.monotonic() + SHARE_URL_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            raw_endpoint = getattr(demo, "share_url", None)
            if raw_endpoint is not None:
                endpoint = _safe_share_url(raw_endpoint)
                if endpoint:
                    break
            time.sleep(0.25)
        endpoint = _safe_share_url(endpoint)
        access_key = namespace.get("ACCESS_KEY")
        if not isinstance(access_key, str) or not access_key:
            raise RuntimeError("Canonical backend access key missing")
    return endpoint, access_key


def _run() -> None:
    _secure_dir()
    lock_directory_fd, lock_fd = _open_api_file(
        LOCK_PATH.name,
        os.O_RDWR | os.O_CREAT,
        0o600,
    )
    try:
        os.fchmod(lock_fd, 0o600)
        with os.fdopen(lock_fd, "r+", encoding="utf-8") as lock_file:
            lock_fd = -1
        # Lock only registration. Progress calls take the same lock and must
        # remain usable while installation/model loading/Gradio are running.
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            current = _read_status()
            current_stage = current.get("stage")
            current_pid = current.get("pid")
            if current_stage == "error":
                return
            if current_pid != os.getpid() or current.get("attempt") != BOOTSTRAP_ATTEMPT:
                # A stale/duplicate process must not overwrite the registered one.
                return
            _write_status("installing", "Installing the pinned Seed-VC runtime.")
    finally:
        if lock_fd != -1:
            os.close(lock_fd)
        os.close(lock_directory_fd)
    _run_child(INSTALL_SOURCE, "Seed-VC installation")
    _write_status("loading", "Checking the Colab runtime and loading the model.")
    _run_child(PREFLIGHT_SOURCE, "Colab preflight")
    _require_tesla_t4()
    endpoint, access_key = _load_and_launch()
    _write_status(
        "ready",
        "Colab backend is ready.",
        endpoint=endpoint,
        accessKey=access_key,
    )
    # Keep the Gradio server process alive without holding the startup lock.
    # This is a real wait, not a fake activity loop or keep-alive request.
    threading.Event().wait()


def main() -> None:
    try:
        _run()
    except Exception:
        # Never expose tracebacks, package output, URLs, or access codes through
        # the public execute_code result. The private status file is the only
        # observable failure channel and intentionally contains a generic error.
        try:
            _write_status("error", "Colab backend bootstrap failed. Check the runtime and try again.")
        except Exception:
            pass


if __name__ == "__main__":
    main()
