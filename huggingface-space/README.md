---
title: AccentLab Studio — v5 fallback
sdk: docker
app_port: 7860
suggested_hardware: t4-small
---

# AccentLab Studio Hugging Face fallback

This directory is a deployable template for a **separate Hugging Face Space**. It is not the AccentLab website and does not replace or transfer the existing Webdev project. `scripts/sync-huggingface-space.py` copies the canonical v5 backend from `colab/accentlab_seedvc_backend.py` into `app.py`; run the sync check before release.

The Docker build pins the same Seed-VC source commit and carries forward the existing v5 Python backend and text-safety checks. The Space uses a protected `ACCENTLAB_ACCESS_KEY` secret for its Gradio API. The app does not log that key. The website stores a separate Hugging Face management token only on its server; neither that token nor any HF API token is used in the browser. Never add secret values to this directory, a Git commit, or a Space README.

## Setup boundary

No Space is created by this repository or its scripts. The Space template does not set the paid `hardware` field; `suggested_hardware` is informational. Create a Space only after separately confirming the exact Hugging Face account/namespace and billing terms. A T4-small currently costs $0.40 per running hour, billed by the minute. Personal GPU Spaces may require an eligible plan (possibly PRO) and billing setup. Starting paid hardware and enabling billing are outside the development/test workflow and require a separate explicit approval. A Space can be created without GPU hardware and remains unavailable for v5 inference until a compatible T4-small is deliberately configured.

For the browser Gradio client to call the app without exposing the management token, the Space application endpoint must be reachable over HTTPS. The app-level access key protects the Gradio API; the site only releases it to the server-verified allowlisted Google account. Do not publish or share that access key. If the Space is made private, a server-side inference proxy must be added rather than exposing an HF token to the browser.

Configure the matching random access-key value as the Space secret `ACCENTLAB_ACCESS_KEY` and, through the existing website server's protected secret-entry flow, as `HUGGINGFACE_SPACE_ACCESS_KEY`. The website's server-side settings are `HUGGINGFACE_TOKEN`, `HUGGINGFACE_SPACE_ID` (`account-or-org/space-name`), `HUGGINGFACE_SPACE_ACCESS_KEY`, and `HF_CONTROL_ALLOWED_EMAIL`. Google OAuth continues to use `GOOGLE_COLAB_CLIENT_ID` and `GOOGLE_COLAB_CLIENT_SECRET`; the Hugging Face owner flow requests only verified Google `openid email` identity through the already registered Colab callback. The allowlisted email is configuration, not source code. Do not put its value in this repository.

The existing website database must apply `drizzle/0001_huggingface_generation_leases.sql` before HF connection/start/pause controls are enabled. This shared row lock serializes generation and pause across server instances and restarts; HF session credentials are withheld if the database or migration is unavailable. Apply that migration only as part of the reviewed website deployment; local tests inject an in-memory lock and never connect to a database.

## Audio handling

The website uploads selected references only when generation begins; optional laugh/giggle and required sob audio are sent only when the current cue needs them. The hosted wrapper deletes Gradio input uploads after every generation attempt, including validation and processing failures. Prepared references and event audio use temporary directories removed when generation completes. A one-minute cleanup scan removes orphaned Gradio files and generated WAVs older than five minutes. The Docker template does not configure persistent storage. No Google Drive access or copying is used. Avoid sensitive recordings and scripts.

The exact v5 readiness check remains `/status`; generation remains `/generate` with the same seven inputs and returned WAV contract. This source alignment is not a live runtime test: Hugging Face's T4-small image build, model load/VRAM fit, complete v5 conversion, pronunciation/text-safety checks, and any voice-similarity percentage remain unverified. Do not claim an 85–95% similarity or alter the model/safeguards to make it fit; validate the full current pipeline on an approved T4-small Space first, and report any limitation instead of downgrading.
