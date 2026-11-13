"""Private, on-demand Modal ASGI worker for AccentLab's canonical v5 backend.

Deploy only after a $10 Workspace usage budget and a $10 spend limit are active.
"""
from __future__ import annotations

from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[1]
BACKEND_SOURCE = ROOT / "colab" / "accentlab_seedvc_backend.py"
INSTALLER_SOURCE = ROOT / "huggingface-space" / "install_deps.py"
SEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8"
MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_BODY_BYTES = 84 * 1024 * 1024
MAX_OUTPUT_BYTES = 100 * 1024 * 1024
ALLOWED_AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".aac", ".flac"}

app = modal.App("accentlab-studio-v5")

worker_image = (
    modal.Image.from_registry("pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime")
    .apt_install("ffmpeg", "git", "libsndfile1", "ca-certificates")
    .pip_install(
        "fastapi==0.115.12",
        "python-multipart==0.0.20",
        "gradio==5.49.1",
        "pydub==0.25.1",
    )
    .add_local_file(
        str(BACKEND_SOURCE),
        remote_path="/root/accentlab/accentlab_seedvc_backend.py",
        copy=True,
    )
    .add_local_file(
        str(INSTALLER_SOURCE),
        remote_path="/root/accentlab/install_deps.py",
        copy=True,
    )
    .env(
        {
            "ACCENTLAB_MODAL_RUNTIME": "1",
            "ACCENTLAB_DISABLE_AUTOSTART": "1",
            "ACCENTLAB_OUTPUT_DIR": "/tmp/accentlab_outputs",
            "ACCENTLAB_ASR_CACHE": "/tmp/accentlab-model-cache",
            "SEED_VC_ROOT": "/opt/seed-vc",
            "PYTHONUNBUFFERED": "1",
        }
    )
    .run_commands(
        f"SEED_VC_ROOT=/opt/seed-vc python /root/accentlab/install_deps.py",
        f"git -C /opt/seed-vc rev-parse HEAD | grep -Fx {SEED_VC_COMMIT}",
    )
)


@app.function(
    image=worker_image,
    gpu="T4",
    cpu=4,
    memory=16 * 1024,
    timeout=20 * 60,
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app(requires_proxy_auth=True)
def accentlab_api():
    """Expose only a proxy-token-protected generation endpoint."""
    import asyncio
    import logging
    import os
    import sys
    import tempfile
    from pathlib import Path as RemotePath

    from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
    from fastapi.responses import JSONResponse, Response

    sys.path.insert(0, "/root/accentlab")
    import accentlab_seedvc_backend as backend

    service = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    logger = logging.getLogger("accentlab.modal")

    @service.middleware("http")
    async def limit_multipart_body(request: Request, call_next):
        if request.method == "POST" and request.url.path == "/generate":
            content_type = request.headers.get("content-type", "")
            if not content_type.lower().startswith("multipart/form-data;"):
                return JSONResponse(
                    {"error": "Expected a multipart audio-generation request."},
                    status_code=415,
                    headers={"Cache-Control": "no-store"},
                )
            declared_length = request.headers.get("content-length")
            if declared_length is not None:
                try:
                    body_length = int(declared_length)
                except ValueError:
                    body_length = -1
                if body_length < 1 or body_length > MAX_BODY_BYTES:
                    return JSONResponse(
                        {"error": "Audio request exceeds the 84 MB limit."},
                        status_code=413,
                        headers={"Cache-Control": "no-store"},
                    )
        return await call_next(request)

    async def read_upload(upload: UploadFile | None, label: str):
        if upload is None:
            return None
        suffix = RemotePath(upload.filename or "").suffix.lower()
        if suffix not in ALLOWED_AUDIO_SUFFIXES:
            raise HTTPException(status_code=422, detail=f"{label} audio format is unsupported.")
        data = await upload.read(MAX_AUDIO_BYTES + 1)
        if not data:
            raise HTTPException(status_code=422, detail=f"{label} audio is empty.")
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail=f"{label} audio exceeds the 20 MB limit.")
        return data, suffix

    def run_v5(
        source_data: bytes,
        source_suffix: str,
        accent_data: bytes,
        accent_suffix: str,
        script: str,
        consent: bool,
        laugh_data: bytes | None,
        laugh_suffix: str | None,
        sob_data: bytes | None,
        sob_suffix: str | None,
    ) -> bytes:
        backend.initialize_runtime()
        if backend.MODEL is None:
            raise RuntimeError("model_not_ready")
        with tempfile.TemporaryDirectory(prefix="accentlab-modal-") as temp_dir:
            temp_root = RemotePath(temp_dir)
            source_path = temp_root / f"source{source_suffix}"
            accent_path = temp_root / f"accent{accent_suffix}"
            source_path.write_bytes(source_data)
            accent_path.write_bytes(accent_data)
            laugh_path = None
            sob_path = None
            if laugh_data is not None and laugh_suffix is not None:
                laugh_path = temp_root / f"laugh{laugh_suffix}"
                laugh_path.write_bytes(laugh_data)
            if sob_data is not None and sob_suffix is not None:
                sob_path = temp_root / f"sob{sob_suffix}"
                sob_path.write_bytes(sob_data)

            output_path: RemotePath | None = None
            try:
                generated = backend._generate_impl(
                    str(source_path),
                    str(accent_path),
                    script,
                    backend.ACCESS_KEY,
                    consent,
                    str(laugh_path) if laugh_path else None,
                    str(sob_path) if sob_path else None,
                    progress=lambda *_args, **_kwargs: None,
                )
                output_path = RemotePath(generated).resolve(strict=True)
                output_root = RemotePath(backend.OUTPUT_DIR).resolve()
                if not output_path.is_relative_to(output_root) or not output_path.is_file():
                    raise RuntimeError("output_path_invalid")
                if output_path.stat().st_size > MAX_OUTPUT_BYTES:
                    raise RuntimeError("output_too_large")
                audio = output_path.read_bytes()
                if (
                    len(audio) < 12
                    or audio[:4] != b"RIFF"
                    or audio[8:12] != b"WAVE"
                ):
                    raise RuntimeError("output_not_wav")
                return audio
            finally:
                if output_path is not None:
                    try:
                        output_path.unlink(missing_ok=True)
                    except OSError:
                        pass

    @service.post("/generate")
    async def generate_audio(
        request: Request,
        source_voice: UploadFile = File(..., alias="sourceVoice"),
        accent_reference: UploadFile = File(..., alias="accentReference"),
        script: str = Form(..., max_length=1200),
        consent: bool = Form(...),
        laugh_sample: UploadFile | None = File(None, alias="laughSample"),
        sob_sample: UploadFile | None = File(None, alias="sobSample"),
    ):
        if not consent:
            raise HTTPException(status_code=400, detail="Recording permission is required.")
        if not script.strip() or len(script) > 1200:
            raise HTTPException(status_code=422, detail="Script must contain 1–1200 characters.")
        try:
            source = await read_upload(source_voice, "Original voice")
            accent = await read_upload(accent_reference, "Accent reference")
            laugh = await read_upload(laugh_sample, "Laugh/giggle sample")
            sob = await read_upload(sob_sample, "Cry/sob sample")
            if source is None or accent is None:
                raise HTTPException(status_code=422, detail="Both reference recordings are required.")
            audio = await asyncio.to_thread(
                run_v5,
                source[0],
                source[1],
                accent[0],
                accent[1],
                script,
                consent,
                laugh[0] if laugh else None,
                laugh[1] if laugh else None,
                sob[0] if sob else None,
                sob[1] if sob else None,
            )
            return Response(
                content=audio,
                media_type="audio/wav",
                headers={
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Disposition": 'attachment; filename="accentlab_result.wav"',
                },
            )
        except HTTPException:
            raise
        except backend.gr.Error as exc:
            message = str(exc)
            if message.startswith("Conversion failed:"):
                message = "Conversion failed. Please check the references and retry after this request ends."
            raise HTTPException(status_code=422, detail=message[:240]) from None
        except Exception as exc:
            logger.warning("Modal v5 generation failed (%s)", type(exc).__name__)
            if str(exc) == "model_not_ready":
                raise HTTPException(
                    status_code=503,
                    detail="The T4 worker could not initialize Seed-VC. No audio was returned.",
                ) from None
            if str(exc) == "output_too_large":
                raise HTTPException(status_code=502, detail="Generated audio exceeded the safety limit.") from None
            raise HTTPException(
                status_code=502,
                detail="Modal generation failed safely. No partial audio was returned.",
            ) from None

    return service
