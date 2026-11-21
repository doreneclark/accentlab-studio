import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";

const backendPath = resolve(process.cwd(), "colab/accentlab_seedvc_backend.py");
const backendSource = readFileSync(backendPath, "utf8");

const PYTHON_FIDELITY_HARNESS = String.raw`
import ast
import math
import io
import json
import os
import secrets
import sys
import tempfile
import threading
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Iterable

import numpy as np

source = sys.stdin.read()
tree = ast.parse(source, filename="accentlab_seedvc_backend.py")
wanted = {
    "_status",
    "_audio_duration",
    "_prepare_reference",
    "_prepare_vocalization",
    "_parse_expression_script",
    "_safe_wav_audio",
    "_collect_final_audio",
    "_convert_once",
    "_generate",
    "_split_script",
    "_join_audio_chunks",
    "_normalize_words",
    "_compare_transcript",
    "_verification_requires_retry",
}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
assert {node.name for node in functions} == wanted

# Execute only selected function definitions. No backend imports, model packages,
# network calls, or runtime launch code are evaluated by this harness.
namespace = {
    "Any": object,
    "Iterable": Iterable,
    "re": re,
    "math": math,
    "Path": Path,
    "np": np,
    "secrets": secrets,
    "tempfile": tempfile,
    "threading": threading,
    "os": os,
}
class GrError(Exception):
    pass
namespace["gr"] = SimpleNamespace(
    Error=GrError,
    Progress=lambda: (lambda *args, **kwargs: None),
)
namespace["DIFFUSION_STEPS"] = 50
exec(compile(ast.Module(body=functions, type_ignores=[]), "backend-functions.py", "exec"), namespace, namespace)
namespace["torch"] = SimpleNamespace(device=lambda value: value, float16="float16")
namespace["PIPELINE_VERSION"] = "identity-anchored-v5-expressive-text-safe"
namespace["DIFFUSION_STEPS"] = 50
namespace["ACCENT_TO_SOURCE_SIMILARITY"] = 0.93
namespace["BLENDED_PROMPT_SIMILARITY"] = 0.80
namespace["PRONUNCIATION_MIN_CONFIDENCE"] = 0.35
namespace["PRONUNCIATION_MAX_ATTEMPTS"] = 2
namespace["RETRY_DIFFUSION_STEPS"] = 40
namespace["RETRY_SIMILARITY"] = 0.65
namespace["RETRY_REPETITION_PENALTY"] = 1.2
namespace["SAMPLE_RATE"] = 22050
namespace["MAX_REFERENCE_DECODE_SECONDS"] = 30.0
namespace["MAX_REFERENCE_SECONDS"] = 25.0
namespace["MAX_VOCALIZATION_DECODE_SECONDS"] = 12.0
namespace["MAX_VOCALIZATION_SECONDS"] = 8.0
namespace["MAX_VOCALIZATION_CUES"] = 6
namespace["REFERENCE_SILENCE_TOP_DB"] = 40.0
namespace["NEAR_SILENT_PEAK"] = 1e-4
namespace["EXPRESSION_CUE_PATTERN"] = re.compile(r"\[(mood:(?:neutral|playful|excited|sad|calm)|laugh|giggle|sob)\]", re.IGNORECASE)
namespace["MAX_SCRIPT_CHARS"] = 1200
namespace["CHUNK_TARGET_CHARS"] = 260
namespace["CHUNK_GAP_SECONDS"] = 0.08
namespace["MODEL_ERROR"] = None
namespace["OUTPUT_DIR"] = Path(tempfile.mkdtemp(prefix="accentlab-fidelity-"))
namespace["OUTPUT_RETENTION_SECONDS"] = 3600

# Verify punctuation/case normalization and mismatch classification.
assert namespace["_normalize_words"]("Hello, WORLD! It's Accent-Lab.") == ["hello", "world", "it's", "accent", "lab"]
matched = namespace["_compare_transcript"]("Hello, world!", "hello WORLD", 0.9)
assert matched["ok"] and not matched["missing"]
missing = namespace["_compare_transcript"]("hello brave world", "hello world", 0.9)
assert missing["missing"] == ["brave"] and namespace["_verification_requires_retry"](missing)
repeated = namespace["_compare_transcript"]("hello world", "hello hello world", 0.9)
assert repeated["unexpected"] == ["hello"]
substitution = namespace["_compare_transcript"]("hello world", "hello words", 0.9)
assert substitution["substitutions"]
uncertain = namespace["_compare_transcript"]("hello world", "hello world", 0.2)
assert uncertain["uncertain"] and not namespace["_verification_requires_retry"](uncertain)

# Verify edge-only trimming, 30-second decode bounding, 25-second post-trim cap,
# finite/silence guards, and preservation of an internal pause.
prepared_writes = []
reference_wave = np.concatenate([
    np.zeros(4, dtype=np.float32),
    np.ones(6, dtype=np.float32) * 0.2,
    np.zeros(3, dtype=np.float32),
    np.ones(6, dtype=np.float32) * 0.3,
    np.zeros(4, dtype=np.float32),
])
vocalization_wave = np.ones(22050 * 10, dtype=np.float32) * 0.2
class Effects:
    @staticmethod
    def trim(wave, top_db, frame_length, hop_length):
        assert top_db == 40.0
        assert frame_length == 2048 and hop_length == 512
        return (wave[4:-4] if wave.size == reference_wave.size else wave[2:-2]), None
class Librosa:
    effects = Effects()
    @staticmethod
    def get_duration(path):
        return 1.0
    @staticmethod
    def load(path, sr, mono, duration):
        assert sr == 22050 and mono is True
        if duration == 30.0:
            return reference_wave, sr
        assert duration == 12.0
        return vocalization_wave, sr
class SoundFile:
    @staticmethod
    def write(path, wave, sr, subtype):
        assert subtype == "PCM_16" and sr == 22050
        prepared_writes.append(np.array(wave))
    @staticmethod
    def info(path):
        return None
namespace["librosa"] = Librosa
namespace["sf"] = SoundFile
namespace["_prepare_reference"]("reference.wav", Path("prepared.wav"), "Original voice")
assert len(prepared_writes) == 1
assert prepared_writes[0].size == reference_wave.size - 8
assert np.any(prepared_writes[0] == 0.0), "internal pause must not be trimmed"
prepared_event = namespace["_prepare_vocalization"]("laugh.wav", "Laugh sample")
assert prepared_event[0] == 22050
assert prepared_event[1].size == int(8.0 * 22050), "event audio must be duration-capped"
parsed = namespace["_parse_expression_script"](
    "[mood:playful]That was funny. [giggle] [mood:sad]I miss you. [sob]"
)
assert parsed == [
    {"kind": "speech", "text": "That was funny.", "mood": "playful"},
    {"kind": "vocalization", "cue": "giggle"},
    {"kind": "speech", "text": "I miss you.", "mood": "sad"},
    {"kind": "vocalization", "cue": "sob"},
]

# Verify proportional output safety without upward normalization or hard clipping.
safe = namespace["_safe_wav_audio"](np.array([0.5, 1.0, -2.0], dtype=np.float32))
assert np.isclose(float(np.max(np.abs(safe))), 0.95)
assert np.isclose(float(safe[0] / safe[1]), 0.5)
quiet = namespace["_safe_wav_audio"](np.array([0.1, -0.2], dtype=np.float32))
assert np.array_equal(quiet, np.array([0.1, -0.2], dtype=np.float32))
try:
    namespace["_safe_wav_audio"](np.array([np.nan], dtype=np.float32))
except RuntimeError:
    pass
else:
    raise AssertionError("non-finite output must be rejected")

class Model:
    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on
    def convert_voice_with_streaming(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail_on is not None and len(self.calls) == self.fail_on:
            raise RuntimeError("simulated final-pass failure")
        return [(None, (22050, np.ones(22050, dtype=np.float32) * 0.1))]

model = Model()
progress_events = []
namespace["_key_is_valid"] = lambda key: key == "valid"
namespace["GPU_AVAILABLE"] = True
namespace["MODEL"] = model
namespace["GENERATION_LOCK"] = threading.Lock()
namespace["_validate_audio"] = lambda path, label: path
namespace["_cleanup_old_outputs"] = lambda: None
namespace["_prepare_reference"] = lambda original, prepared, label: prepared.write_bytes(b"prepared")
tts_moods = []
namespace["_make_neutral_speech"] = lambda text, output, mood="neutral": (tts_moods.append((text, mood)), Path(output).write_bytes(b"neutral"))[1]
written_paths = []
def write_safe(path, audio, sample_rate):
    written_paths.append(Path(path).name)
    Path(path).write_bytes(b"wav")
namespace["_write_safe_wav"] = write_safe
namespace["_verify_chunk"] = lambda path, expected: {"ok": True, "uncertain": False, "missing": [], "unexpected": [], "substitutions": []}

result = namespace["_generate"](
    "original-upload.wav",
    "accent-upload.wav",
    "Exact script",
    "valid",
    True,
    progress=lambda value, desc: progress_events.append((value, desc)),
)
assert result.endswith(".wav")
assert len(model.calls) == 2
assert [call["convert_style"] for call in model.calls] == [False, True]
assert [call["similarity_cfg_rate"] for call in model.calls] == [0.93, 0.80]
assert all(call["diffusion_steps"] == 50 for call in model.calls)
assert all(call["intelligebility_cfg_rate"] == 0.7 for call in model.calls)
assert all(call["top_p"] == 0.7 for call in model.calls)
assert all(call["temperature"] == 0.7 for call in model.calls)
assert all(call["repetition_penalty"] == 1.5 for call in model.calls)
assert model.calls[0]["source_audio_path"].endswith("accent_reference.wav")
assert model.calls[0]["target_audio_path"].endswith("source_reference.wav")
assert model.calls[1]["source_audio_path"].endswith("mood_scaffold_1.wav")
assert model.calls[1]["target_audio_path"].endswith("accent_reference_in_source_voice.wav")
assert progress_events[-1][0] == 1.0
assert written_paths[-1].startswith("accentlab_")
assert tts_moods[-1] == ("Exact script", "neutral")

# Vocal events are inserted in order from the supplied clip and never enter ASR.
event_model = Model()
namespace["MODEL"] = event_model
final_arrays = []
def write_safe_with_capture(path, audio, sample_rate):
    final_arrays.append(np.asarray(audio, dtype=np.float32).copy())
    write_safe(path, audio, sample_rate)
namespace["_write_safe_wav"] = write_safe_with_capture
namespace["_verify_chunk"] = lambda path, expected: {"ok": True, "uncertain": False, "missing": [], "unexpected": [], "substitutions": []}
event_result = namespace["_generate"](
    "original-upload.wav", "accent-upload.wav",
    "[mood:playful]First line. [laugh] [mood:sad]Second line.",
    "valid", True, "laugh.wav", None,
    progress=lambda *args, **kwargs: None,
)
assert event_result.endswith(".wav")
assert len(event_model.calls) == 3, "one accent pass plus two speech segments; no event conversion"
assert [item[1] for item in tts_moods[-2:]] == ["playful", "sad"]
event_output = final_arrays[-1]
event_indices = np.where(np.isclose(event_output, 0.2))[0]
assert event_indices.size > 0
assert 22050 < event_indices[0] < event_output.size - 22050

optional_laugh_model = Model()
namespace["MODEL"] = optional_laugh_model
optional_progress = []
optional_laugh_result = namespace["_generate"](
    "original-upload.wav", "accent-upload.wav",
    "[mood:playful]First line. [laugh] [mood:sad]Second line.",
    "valid", True, None, None,
    progress=lambda value, desc: optional_progress.append((value, desc)),
)
assert optional_laugh_result.endswith(".wav")
assert len(optional_laugh_model.calls) == 3
assert any("Skipping the laugh cue" in desc for _, desc in optional_progress)
optional_laugh_output = final_arrays[-1]
assert not np.any(np.isclose(optional_laugh_output, 0.2)), "an absent laugh sample must not create audio"

try:
    namespace["_generate"](
        "original-upload.wav", "accent-upload.wav", "[giggle]", "valid", True,
        progress=lambda *args, **kwargs: None,
    )
except GrError as error:
    assert "No spoken words remain after skipping optional" in str(error)
else:
    raise AssertionError("an event-only unsampled laugh must not return an empty WAV")

try:
    namespace["_generate"](
        "original-upload.wav", "accent-upload.wav", "[sob]", "valid", True,
        progress=lambda *args, **kwargs: None,
    )
except GrError as error:
    assert "cry/sob sample" in str(error)
else:
    raise AssertionError("sob cue must require its original-speaker sample")

# A definite word mismatch retries only the failed chunk with safer settings.
retry_model = Model()
namespace["MODEL"] = retry_model
verification_results = iter([
    {"ok": False, "uncertain": False, "missing": ["brave"], "unexpected": [], "substitutions": []},
    {"ok": True, "uncertain": False, "missing": [], "unexpected": [], "substitutions": []},
])
namespace["_verify_chunk"] = lambda path, expected: next(verification_results)
retry_result = namespace["_generate"](
    "original-upload.wav", "accent-upload.wav", "Exact script", "valid", True,
    progress=lambda *args, **kwargs: progress_events.append((args, kwargs)),
)
assert retry_result.endswith(".wav")
assert len(retry_model.calls) == 3
assert retry_model.calls[-1]["diffusion_steps"] == 40
assert retry_model.calls[-1]["similarity_cfg_rate"] == 0.65
assert retry_model.calls[-1]["repetition_penalty"] == 1.2

# A conversion error must not return an incomplete intermediate output.
failed_model = Model(fail_on=1)
namespace["MODEL"] = failed_model
written_paths.clear()
try:
    namespace["_generate"]("original-upload.wav", "accent-upload.wav", "Exact script", "valid", True, progress=lambda *args, **kwargs: None)
except GrError as error:
    assert "Conversion failed" in str(error)
else:
    raise AssertionError("conversion failure must fail the generation")
assert len(failed_model.calls) == 1
assert not any(name.startswith("accentlab_") for name in written_paths), "no final output may be returned on second-pass failure"

# Authorized status carries the version; unauthorized status remains concealed.
namespace["GPU_AVAILABLE"] = True
namespace["MODEL"] = object()
assert namespace["_status"]("valid")["pipeline_version"] == "identity-anchored-v5-expressive-text-safe"
unauthorized = namespace["_status"]("wrong")
assert "pipeline_version" not in unauthorized
assert unauthorized.get("ready") is False
assert unauthorized.get("gpu") is False
assert unauthorized.get("sample_rate") == 22050
assert unauthorized.get("message") == "Invalid access code."

print(json.dumps({"ok": True, "calls": 2, "pipeline_version": "identity-anchored-v5-expressive-text-safe"}))
`;

describe("identity-anchored backend fidelity", () => {
  it("traces the two-pass text-safe pipeline and guardrails without ML dependencies", () => {
    const output = execFileSync("python3", ["-c", PYTHON_FIDELITY_HARNESS], {
      input: backendSource,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!output.includes('"ok": true')) {
      throw new Error(`fidelity harness did not confirm success: ${output}`);
    }
  });
});
