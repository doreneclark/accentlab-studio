"""AccentLab experimental two-reference Seed-VC v2 backend.

This module runs from a pinned checkout of the official Seed-VC repository in a
free Google Colab T4 runtime. It is an experimental approximation, not a model-
level disentangler of speaker identity and accent, and does not promise an
identity, naturalness, or accent improvement.

The public Gradio API is intentionally small and stable:

* ``/status``: ``access_key: str`` -> JSON with ``ready``, ``gpu``,
  ``sample_rate``, ``pipeline_version`` and ``message`` for authorized callers.
* ``/generate``: ``source_voice: filepath``, ``accent_reference: filepath``,
  ``script: str``, ``access_key: str``, ``consent: bool`` -> an audio filepath.

The access key is generated at process launch and is never stored in this
source file. The caller must supply it for both endpoints.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import secrets
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import edge_tts
import gradio as gr
import librosa
import numpy as np
import soundfile as sf
import torch
import yaml

# The notebook sets this to the clone directory. Keeping it configurable also
# lets the Python file be run directly after the same installation cell.
SEED_VC_ROOT = Path(os.environ.get("SEED_VC_ROOT", "/content/seed-vc"))
SEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8"
PIPELINE_VERSION = "identity-anchored-v3-text-safe"
# V2 is a conservative quality trial: more diffusion steps and gradually
# stronger conditioning toward the relevant source/accent references.
DIFFUSION_STEPS = 50
ACCENT_TO_SOURCE_SIMILARITY = 0.93
BLENDED_PROMPT_SIMILARITY = 0.80
SAMPLE_RATE = 22050
MAX_SCRIPT_CHARS = 1200
CHUNK_TARGET_CHARS = 260
TTS_RETRIES = 3
CHUNK_GAP_SECONDS = 0.08
MAX_REFERENCE_DECODE_SECONDS = 30.0
MAX_REFERENCE_SECONDS = 25.0
REFERENCE_SILENCE_TOP_DB = 40.0
NEAR_SILENT_PEAK = 1e-4
OUTPUT_RETENTION_SECONDS = 60 * 60
OUTPUT_DIR = Path(tempfile.gettempdir()) / "accentlab_outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# The generated value is printed once at launch for the notebook owner. It is
# intentionally not a constant in the notebook or repository.
ACCESS_KEY = secrets.token_urlsafe(18)
ACCESS_KEY_DIGEST = hashlib.sha256(ACCESS_KEY.encode("utf-8")).digest()
print(f"AccentLab access code (keep private): {ACCESS_KEY}")
print(f"Seed-VC source pin: {SEED_VC_COMMIT}")
print(f"AccentLab pipeline: {PIPELINE_VERSION}")

MODEL: Any | None = None
MODEL_ERROR: str | None = None
GPU_AVAILABLE = bool(torch.cuda.is_available())
GENERATION_LOCK = threading.Lock()


def _key_is_valid(access_key: Any) -> bool:
    """Compare a submitted key without exposing the stored key."""
    if not isinstance(access_key, str) or not access_key:
        return False
    candidate_digest = hashlib.sha256(access_key.encode("utf-8")).digest()
    return hmac.compare_digest(candidate_digest, ACCESS_KEY_DIGEST)


def _seed_vc_import_path() -> None:
    """Make the pinned checkout importable without changing global cwd."""
    if not SEED_VC_ROOT.is_dir():
        raise RuntimeError(
            f"Pinned Seed-VC checkout is missing at {SEED_VC_ROOT}. "
            "Run the notebook installation cell first."
        )
    checkout_head = os.popen(f"git -C {shlex_quote(str(SEED_VC_ROOT))} rev-parse HEAD 2>/dev/null").read().strip()
    if checkout_head and checkout_head != SEED_VC_COMMIT:
        raise RuntimeError(
            f"Seed-VC checkout is {checkout_head}, expected pinned commit {SEED_VC_COMMIT}."
        )
    root = str(SEED_VC_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


def shlex_quote(value: str) -> str:
    """Small local shell-quoting helper used only for a read-only git check."""
    import shlex

    return shlex.quote(value)


def _load_v2_model() -> Any:
    """Instantiate the official v2 wrapper and load its default HF weights."""
    global MODEL, MODEL_ERROR
    if MODEL is not None:
        return MODEL
    if not GPU_AVAILABLE:
        raise RuntimeError("A CUDA GPU is required; select a free Colab T4 runtime.")

    _seed_vc_import_path()
    from hydra.utils import instantiate
    from omegaconf import DictConfig

    config_path = SEED_VC_ROOT / "configs" / "v2" / "vc_wrapper.yaml"
    with config_path.open("r", encoding="utf-8") as config_file:
        config = DictConfig(yaml.safe_load(config_file))
    wrapper = instantiate(config)
    # These are the official VoiceConversionWrapper methods from the pinned
    # Seed-VC commit. No unsupported SeedVCWrapper.convert_voice API is used.
    wrapper.load_checkpoints(ar_checkpoint_path=None, cfm_checkpoint_path=None)
    device = torch.device("cuda")
    dtype = torch.float16
    wrapper.to(device)
    wrapper.eval()
    wrapper.setup_ar_caches(max_batch_size=1, max_seq_len=4096, dtype=dtype, device=device)
    MODEL = wrapper
    MODEL_ERROR = None
    return wrapper


def initialize_runtime() -> None:
    """Preload the model so /status can report truthful readiness."""
    global MODEL_ERROR
    if not GPU_AVAILABLE:
        MODEL_ERROR = "CUDA GPU unavailable; choose Runtime > Change runtime type > T4 GPU."
        print(f"AccentLab not ready: {MODEL_ERROR}")
        return
    try:
        print("Loading Seed-VC v2 checkpoints; first launch downloads weights from Hugging Face...")
        _load_v2_model()
        print("AccentLab model is ready.")
    except Exception as exc:  # Keep Gradio alive so /status can explain failure.
        MODEL_ERROR = f"Model initialization failed: {type(exc).__name__}: {exc}"
        print(f"AccentLab not ready: {MODEL_ERROR}")


def _status(access_key: str) -> dict[str, Any]:
    """Return the health contract, without revealing unauthorized state."""
    if not _key_is_valid(access_key):
        return {
            "ready": False,
            "gpu": False,
            "sample_rate": SAMPLE_RATE,
            "message": "Invalid access code.",
        }
    if not GPU_AVAILABLE:
        return {
            "ready": False,
            "gpu": False,
            "sample_rate": SAMPLE_RATE,
            "pipeline_version": PIPELINE_VERSION,
            "message": "CUDA GPU unavailable; select a free Colab T4 runtime.",
        }
    if MODEL is None:
        return {
            "ready": False,
            "gpu": True,
            "sample_rate": SAMPLE_RATE,
            "pipeline_version": PIPELINE_VERSION,
            "message": MODEL_ERROR or "Seed-VC v2 is still initializing.",
        }
    return {
        "ready": True,
        "gpu": True,
        "sample_rate": SAMPLE_RATE,
        "pipeline_version": PIPELINE_VERSION,
        "message": "Ready. This is an experimental identity-anchored approximation.",
    }


# Pronunciation Guard runs locally in the Colab runtime. It verifies each
# generated chunk against the requested words before any final WAV is returned.
PRONUNCIATION_GUARD_MODEL = os.environ.get("ACCENTLAB_ASR_MODEL", "tiny.en")
PRONUNCIATION_GUARD_CACHE = Path(
    os.environ.get("ACCENTLAB_ASR_CACHE", "/content/accentlab-model-cache")
)
PRONUNCIATION_MIN_CONFIDENCE = 0.35
PRONUNCIATION_MAX_ATTEMPTS = 2
RETRY_DIFFUSION_STEPS = 40
RETRY_SIMILARITY = 0.65
RETRY_REPETITION_PENALTY = 1.2
ASR_MODEL: Any | None = None
ASR_MODEL_ERROR: str | None = None


def _normalize_words(text: str) -> list[str]:
    """Normalize speech text for punctuation/case-insensitive word comparison."""
    lowered = text.casefold().replace("’", "'")
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", lowered)


def _compare_transcript(
    expected_text: str,
    transcript: str,
    confidence: float | None,
) -> dict[str, Any]:
    """Compare normalized words and expose actionable mismatch details."""
    from difflib import SequenceMatcher

    expected = _normalize_words(expected_text)
    actual = _normalize_words(transcript)
    matcher = SequenceMatcher(a=expected, b=actual, autojunk=False)
    missing: list[str] = []
    unexpected: list[str] = []
    substitutions: list[dict[str, list[str]]] = []
    for tag, start_a, end_a, start_b, end_b in matcher.get_opcodes():
        if tag == "delete":
            missing.extend(expected[start_a:end_a])
        elif tag == "insert":
            unexpected.extend(actual[start_b:end_b])
        elif tag == "replace":
            substitutions.append(
                {
                    "expected": expected[start_a:end_a],
                    "actual": actual[start_b:end_b],
                }
            )
    uncertain = confidence is None or confidence < PRONUNCIATION_MIN_CONFIDENCE
    return {
        "ok": bool(expected) and not uncertain and not missing and not unexpected and not substitutions,
        "uncertain": uncertain,
        "confidence": confidence,
        "expected": expected,
        "actual": actual,
        "transcript": transcript.strip(),
        "missing": missing,
        "unexpected": unexpected,
        "substitutions": substitutions,
    }


def _verification_requires_retry(result: dict[str, Any]) -> bool:
    """Retry definite word mismatches, but fail closed on uncertain ASR."""
    return not bool(result.get("ok")) and not bool(result.get("uncertain"))


def _load_pronunciation_model() -> Any:
    """Load a small local Whisper model only when the first generation needs it."""
    global ASR_MODEL, ASR_MODEL_ERROR
    if ASR_MODEL is not None:
        return ASR_MODEL
    if ASR_MODEL_ERROR:
        raise RuntimeError(ASR_MODEL_ERROR)
    try:
        from faster_whisper import WhisperModel

        PRONUNCIATION_GUARD_CACHE.mkdir(parents=True, exist_ok=True)
        device = "cuda" if GPU_AVAILABLE else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        ASR_MODEL = WhisperModel(
            PRONUNCIATION_GUARD_MODEL,
            device=device,
            compute_type=compute_type,
            download_root=str(PRONUNCIATION_GUARD_CACHE),
        )
        return ASR_MODEL
    except Exception as exc:
        ASR_MODEL_ERROR = (
            "Pronunciation Guard could not load its local speech-recognition model. "
            f"{type(exc).__name__}: {exc}"
        )
        raise RuntimeError(ASR_MODEL_ERROR) from exc


def _transcribe_audio(path: str) -> tuple[str, float | None]:
    """Transcribe a generated chunk locally and return text plus conservative confidence."""
    model = _load_pronunciation_model()
    segments, _info = model.transcribe(
        path,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    collected = []
    confidences = []
    for segment in segments:
        text = getattr(segment, "text", "")
        if isinstance(text, str):
            collected.append(text)
        log_probability = getattr(segment, "avg_logprob", None)
        if isinstance(log_probability, (int, float)):
            # Convert Whisper's negative log probability to a bounded score.
            confidences.append(max(0.0, min(1.0, float(np.exp(log_probability)))))
    transcript = " ".join(collected).strip()
    confidence = float(np.mean(confidences)) if confidences else None
    return transcript, confidence


def _verify_chunk(path: str, expected_text: str) -> dict[str, Any]:
    """Verify one output chunk without sending audio outside the Colab VM."""
    transcript, confidence = _transcribe_audio(path)
    return _compare_transcript(expected_text, transcript, confidence)


def _audio_duration(path: str) -> float:
    try:
        return float(librosa.get_duration(path=path))
    except Exception as exc:
        raise ValueError(f"Could not read audio file: {exc}") from exc


def _validate_audio(path: Any, label: str) -> str:
    if not isinstance(path, str) or not path or not Path(path).is_file():
        raise ValueError(f"{label} must be an uploaded audio file.")
    if Path(path).stat().st_size > 20 * 1024 * 1024:
        raise ValueError(f"{label} must be 20 MB or smaller after decoding.")
    duration = _audio_duration(path)
    if duration <= 0.0:
        raise ValueError(f"{label} is empty.")
    return path


def _prepare_reference(original_path: str, prepared_path: Path, label: str) -> None:
    """Decode up to 30 seconds, trim edge silence, then retain at most 25 seconds."""
    wave, sample_rate = librosa.load(
        original_path,
        sr=SAMPLE_RATE,
        mono=True,
        duration=MAX_REFERENCE_DECODE_SECONDS,
    )
    if wave.size == 0 or not np.isfinite(wave).all():
        raise ValueError(f"{label} contains no usable finite audio.")
    if float(np.max(np.abs(wave))) <= NEAR_SILENT_PEAK:
        raise ValueError(f"{label} is silent or near-silent.")
    # librosa.effects.trim only removes leading/trailing silence; internal
    # pauses remain untouched. Do not denoise, pitch-shift, or normalize upward.
    trimmed, _ = librosa.effects.trim(
        wave,
        top_db=REFERENCE_SILENCE_TOP_DB,
        frame_length=2048,
        hop_length=512,
    )
    if trimmed.size == 0 or not np.isfinite(trimmed).all():
        raise ValueError(f"{label} contains no usable audio after edge-silence trimming.")
    max_frames = int(MAX_REFERENCE_SECONDS * sample_rate)
    trimmed = trimmed[:max_frames]
    if trimmed.size == 0 or float(np.max(np.abs(trimmed))) <= NEAR_SILENT_PEAK:
        raise ValueError(f"{label} is silent or near-silent after preparation.")
    sf.write(prepared_path, trimmed, sample_rate, subtype="PCM_16")


async def _tts_to_mp3(text: str, output_path: str) -> None:
    # This is deliberately a neutral, temporary content scaffold. Edge TTS
    # outputs MP3; _make_neutral_speech converts it to a valid WAV below.
    communicate = edge_tts.Communicate(text, "en-US-JennyNeural", rate="+0%")
    await communicate.save(output_path)


def _make_neutral_speech(text: str, output_path: str) -> None:
    """Create a verified neutral scaffold, retrying transient TTS failures."""
    last_error: Exception | None = None
    for attempt in range(TTS_RETRIES):
        mp3_path = f"{output_path}.attempt{attempt}.mp3"
        try:
            asyncio.run(_tts_to_mp3(text, mp3_path))
            from pydub import AudioSegment

            AudioSegment.from_file(mp3_path, format="mp3").set_channels(1).set_frame_rate(
                SAMPLE_RATE
            ).export(output_path, format="wav")
            info = sf.info(output_path)
            if info.frames <= 0 or info.samplerate != SAMPLE_RATE:
                raise RuntimeError("Edge TTS returned an invalid audio file.")
            return
        except Exception as exc:
            last_error = exc
            if attempt + 1 < TTS_RETRIES:
                time.sleep(0.5 * (attempt + 1))
        finally:
            try:
                Path(mp3_path).unlink()
            except FileNotFoundError:
                pass
    raise RuntimeError(f"Neutral TTS failed after {TTS_RETRIES} attempts: {last_error}")


def _split_script(script: str) -> list[str]:
    """Split long text at sentence/word boundaries while preserving all text."""
    normalized = re.sub(r"\s+", " ", script).strip()
    if len(normalized) <= CHUNK_TARGET_CHARS:
        return [normalized]
    sentences = re.split(r"(?<=[.!?。！？])\s+", normalized)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        words = sentence.split()
        if not words:
            continue
        for word in words:
            candidate = f"{current} {word}".strip()
            if current and len(candidate) > CHUNK_TARGET_CHARS:
                chunks.append(current)
                current = word
            else:
                current = candidate
        if current and sentence.endswith((".", "!", "?", "。", "！", "？")):
            chunks.append(current)
            current = ""
    if current:
        chunks.append(current)
    return chunks or [normalized]


def _join_audio_chunks(chunks: list[tuple[int, np.ndarray]]) -> tuple[int, np.ndarray]:
    """Join validated chunks with a tiny silence gap to avoid boundary clicks."""
    if not chunks:
        raise RuntimeError("No converted audio chunks were produced.")
    sample_rate = chunks[0][0]
    if any(rate != sample_rate for rate, _ in chunks):
        raise RuntimeError("Converted chunks used inconsistent sample rates.")
    gap = np.zeros(max(1, int(sample_rate * CHUNK_GAP_SECONDS)), dtype=np.float32)
    pieces: list[np.ndarray] = []
    for index, (_, audio) in enumerate(chunks):
        if index:
            pieces.append(gap)
        pieces.append(np.asarray(audio, dtype=np.float32).squeeze())
    return sample_rate, np.concatenate(pieces)


def _collect_final_audio(outputs: Iterable[Any]) -> tuple[int, np.ndarray]:
    """Collect and validate the final ``(sample_rate, ndarray)`` result."""
    final_audio: Any = None
    for item in outputs:
        if not isinstance(item, tuple) or len(item) != 2:
            continue
        _, full_audio = item
        if full_audio is not None:
            final_audio = full_audio
    if not isinstance(final_audio, tuple) or len(final_audio) != 2:
        raise RuntimeError("Seed-VC returned no complete audio result.")
    sample_rate, audio = final_audio
    audio_array = np.asarray(audio).squeeze()
    if audio_array.size == 0 or not np.isfinite(audio_array).all():
        raise RuntimeError("Seed-VC returned empty or non-finite audio.")
    return int(sample_rate), audio_array.astype(np.float32, copy=False)


def _safe_wav_audio(audio: np.ndarray) -> np.ndarray:
    """Scale peaks above 0.95 proportionally; never hard-clip or raise quiet audio."""
    audio_array = np.asarray(audio, dtype=np.float32).squeeze()
    if audio_array.size == 0 or not np.isfinite(audio_array).all():
        raise RuntimeError("Audio output is empty or non-finite.")
    peak = float(np.max(np.abs(audio_array)))
    if peak > 0.95:
        audio_array = audio_array * (0.95 / peak)
    return audio_array


def _write_safe_wav(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    sf.write(path, _safe_wav_audio(audio), sample_rate, subtype="PCM_16")
    sf.info(path)


def _convert_once(
    model: Any,
    source_path: str,
    target_path: str,
    *,
    convert_style: bool,
    similarity_cfg_rate: float,
    diffusion_steps: int = DIFFUSION_STEPS,
    repetition_penalty: float = 1.5,
) -> tuple[int, np.ndarray]:
    """Run one official v2 conversion with identity/style-specific guidance."""
    device = torch.device("cuda")
    outputs = model.convert_voice_with_streaming(
        source_audio_path=source_path,
        target_audio_path=target_path,
        diffusion_steps=diffusion_steps,
        length_adjust=1.0,
        # The spelling below is part of the pinned upstream API.
        intelligebility_cfg_rate=0.7,
        similarity_cfg_rate=similarity_cfg_rate,
        top_p=0.7,
        temperature=0.7,
        repetition_penalty=repetition_penalty,
        convert_style=convert_style,
        anonymization_only=False,
        device=device,
        dtype=torch.float16,
        stream_output=True,
    )
    return _collect_final_audio(outputs)


def _cleanup_old_outputs() -> None:
    """Bounded retention cleanup; never recursively removes Gradio directories."""
    cutoff = time.time() - OUTPUT_RETENTION_SECONDS
    for candidate in list(OUTPUT_DIR.glob("accentlab_*.wav"))[:256]:
        try:
            if candidate.stat().st_mtime < cutoff:
                candidate.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            continue


def _generate(
    source_voice: str,
    accent_reference: str,
    script: str,
    access_key: str,
    consent: bool,
    progress=gr.Progress(),
) -> str:
    """Generate the final output using a two-pass text-safe approximation. The final pass is deliberately removed because it can erase words."""
    # Authenticate before touching the model or starting any GPU conversion.
    if not _key_is_valid(access_key):
        raise gr.Error("Invalid access code.")
    if not GPU_AVAILABLE:
        raise gr.Error("CUDA GPU unavailable; select a free Colab T4 runtime.")
    if MODEL is None:
        raise gr.Error(MODEL_ERROR or "Seed-VC v2 is not ready yet.")
    if consent is not True:
        raise gr.Error("Confirm that you have permission to transform both recordings.")
    if not isinstance(script, str) or not script.strip():
        raise gr.Error("Enter the words to be spoken.")
    if len(script) > MAX_SCRIPT_CHARS:
        raise gr.Error(f"Text is limited to {MAX_SCRIPT_CHARS} characters.")

    try:
        source_path = _validate_audio(source_voice, "Original voice")
        accent_path = _validate_audio(accent_reference, "French-accent reference")
    except ValueError as exc:
        raise gr.Error(str(exc)) from exc
    if not GENERATION_LOCK.acquire(blocking=False):
        raise gr.Error("Another conversion is running; try again after it finishes.")

    try:
        _cleanup_old_outputs()
        with tempfile.TemporaryDirectory(prefix="accentlab_") as work_dir:
            work = Path(work_dir)
            prepared_source = work / "source_reference.wav"
            prepared_accent = work / "accent_reference.wav"
            _prepare_reference(source_path, prepared_source, "Original voice")
            _prepare_reference(accent_path, prepared_accent, "French-accent reference")
            source_path, accent_path = str(prepared_source), str(prepared_accent)
            blended_prompt = work / "accent_reference_in_source_voice.wav"
            chunks = _split_script(script)
            converted_chunks: list[tuple[int, np.ndarray]] = []

            progress(0.05, desc="Preparing the two reference recordings")

            # Pass 1 is performed once: accent -> original, timbre-focused and
            # without AR style rewrite. Every text chunk reuses this prompt.
            progress(0.15, desc="Adapting the accent reference to the original voice")
            stage1_sr, stage1_audio = _convert_once(
                MODEL,
                accent_path,
                source_path,
                convert_style=False,
                similarity_cfg_rate=ACCENT_TO_SOURCE_SIMILARITY,
            )
            _write_safe_wav(blended_prompt, stage1_audio, stage1_sr)

            # Pass 2 converts each short neutral-TTS chunk independently. This
            # preserves the original two-pass Colab design while limiting word
            # loss to a small segment when scripts are long.
            for index, chunk in enumerate(chunks):
                neutral_wav = work / f"neutral_tts_{index}.wav"
                stage2_wav = work / f"new_speech_{index}.wav"
                _make_neutral_speech(chunk, str(neutral_wav))
                progress(
                    0.20 + 0.65 * ((index + 1) / len(chunks)),
                    desc=f"Generating speech segment {index + 1} of {len(chunks)}",
                )
                progress(
                    0.20 + 0.65 * (index / len(chunks)),
                    desc=f"Converting speech segment {index + 1} of {len(chunks)}",
                )
                segment_result: tuple[int, np.ndarray] | None = None
                last_verification: dict[str, Any] | None = None
                for attempt in range(1, PRONUNCIATION_MAX_ATTEMPTS + 1):
                    if attempt == 1:
                        conversion_steps = DIFFUSION_STEPS
                        conversion_similarity = BLENDED_PROMPT_SIMILARITY
                        conversion_repetition = 1.5
                    else:
                        progress(
                            0.20 + 0.65 * (index / len(chunks)),
                            desc=f"Retrying segment {index + 1} because words were missing.",
                        )
                        conversion_steps = RETRY_DIFFUSION_STEPS
                        conversion_similarity = RETRY_SIMILARITY
                        conversion_repetition = RETRY_REPETITION_PENALTY
                    stage2_sr, stage2_audio = _convert_once(
                        MODEL,
                        str(neutral_wav),
                        str(blended_prompt),
                        convert_style=True,
                        similarity_cfg_rate=conversion_similarity,
                        diffusion_steps=conversion_steps,
                        repetition_penalty=conversion_repetition,
                    )
                    _write_safe_wav(stage2_wav, stage2_audio, stage2_sr)
                    expected_seconds = _audio_duration(str(neutral_wav))
                    actual_seconds = float(np.asarray(stage2_audio).shape[-1]) / float(stage2_sr)
                    if actual_seconds < max(0.8, expected_seconds * 0.55):
                        raise gr.Error(
                            f"Speech segment {index + 1} was much shorter than requested. "
                            "No incomplete audio was returned; retry with shorter text."
                        )
                    last_verification = _verify_chunk(str(stage2_wav), chunk)
                    if last_verification["ok"]:
                        progress(
                            0.20 + 0.65 * ((index + 1) / len(chunks)),
                            desc=f"All requested words detected in segment {index + 1}.",
                        )
                        segment_result = (stage2_sr, stage2_audio)
                        break
                    if last_verification["uncertain"]:
                        raise gr.Error(
                            f"Verification uncertain for segment {index + 1}; please listen carefully. "
                            "No unverified audio was returned."
                        )
                    if attempt == PRONUNCIATION_MAX_ATTEMPTS:
                        missing = ", ".join(last_verification["missing"][:8]) or "some words"
                        raise gr.Error(
                            f"Could not verify segment {index + 1} after {PRONUNCIATION_MAX_ATTEMPTS} attempts; "
                            f"missing: {missing}. No unverified audio was returned."
                        )
                if segment_result is None:
                    raise gr.Error(
                        f"Could not verify segment {index + 1}. No unverified audio was returned."
                    )
                converted_chunks.append(segment_result)

            output_sr, output_audio = _join_audio_chunks(converted_chunks)
            output_path = OUTPUT_DIR / f"accentlab_{secrets.token_hex(12)}.wav"
            _write_safe_wav(output_path, output_audio, output_sr)
            progress(1.0, desc="All requested words detected. Converted WAV ready")
            return str(output_path)
    except gr.Error:
        raise
    except Exception as exc:
        raise gr.Error(f"Conversion failed: {type(exc).__name__}: {exc}") from exc
    finally:
        GENERATION_LOCK.release()


def build_demo() -> gr.Blocks:
    """Build Blocks with the exact /status and /generate API contracts."""
    with gr.Blocks(title="AccentLab Seed-VC v2") as demo:
        gr.Markdown(
            "## AccentLab — experimental two-pass text-safe conversion\n"
            "Use only recordings you have permission to transform. This free Colab "
            "runtime uses the original voice as the final identity reference and "
            "the accent recording to guide pronunciation; it cannot guarantee "
            "perfect identity, naturalness, or accent transfer."
        )
        access_key = gr.Textbox(label="Access code", type="password")
        status_button = gr.Button("Check backend", visible=True)
        status_output = gr.JSON(label="Backend status")
        status_button.click(
            _status,
            inputs=[access_key],
            outputs=[status_output],
            api_name="status",
            queue=False,
        )

        source_voice = gr.Audio(type="filepath", label="Original voice — final identity reference")
        accent_reference = gr.Audio(type="filepath", label="French-accent reference — accent/style")
        script = gr.Textbox(
            lines=7,
            max_lines=14,
            max_length=MAX_SCRIPT_CHARS,
            label="New text (maximum 1200 characters)",
        )
        consent = gr.Checkbox(
            label="I have permission to transform both recordings.", value=False
        )
        generate_button = gr.Button("Generate", variant="primary")
        result = gr.Audio(type="filepath", label="Converted WAV")
        generate_button.click(
            _generate,
            inputs=[source_voice, accent_reference, script, access_key, consent],
            outputs=[result],
            api_name="generate",
        )
        gr.Markdown(
            "The temporary shared URL is public to anyone who has it while this "
            "Colab session runs. Uploaded audio and generated files are processed "
            "in the temporary runtime; do not use sensitive recordings."
        )
    return demo


initialize_runtime()
demo = build_demo()
demo.queue(default_concurrency_limit=1)
print("Starting temporary Gradio URL; keep this Colab tab open while using it.")
demo.launch(share=True, debug=True, max_file_size="20mb")
