# AccentLab free Google Colab backend

This folder contains an experimental two-reference backend built around the official Seed-VC v2 `VoiceConversionWrapper`. It uses the original recording as a speaker-identity reference and a French-accent recording as an accent/style reference. The identity-anchored default first converts the accent reference toward the original speaker, then converts short temporary TTS segments toward that blended prompt. The final identity reference is the original speaker recording; there is no third timbre-only pass because it can erase words.

This is an approximation, not a trained identity/accent disentangling model. It cannot guarantee perfect speaker identity, French accent, pronunciation, or naturalness. The temporary TTS scaffold is `edge-tts` with `en-US-JennyNeural`; its MP3 output is decoded and exported as a valid WAV before Seed-VC uses it. The accent/style behavior comes from the experimental Seed-VC v2 conversion stage, not from a claim that the TTS voice itself is French-accented.

The text-safe v3 pipeline uses 50 diffusion steps and reference guidance of 0.93 for accent-to-source adaptation and 0.80 for each short blended-script segment. Pronunciation Guard runs a local `faster-whisper` tiny English model inside Colab, checks every output chunk against the requested words, retries one definite mismatch with safer settings, and returns no audio when verification is uncertain or still fails. Intelligibility guidance remains 0.7; style sampling remains top-p 0.7, temperature 0.7, and repetition penalty 1.5. These are experimental inference settings, not a measured improvement or a similarity percentage. The added steps and stronger guidance may take longer and can still introduce artifacts, weaken the accent, or sound less natural. No personal fine-tuning or paid service is added.

## Run it

1. In Google Colab, open [`accentlab_seedvc_backend.ipynb`](./accentlab_seedvc_backend.ipynb).
2. Select **Runtime > Change runtime type > T4 GPU**. A CPU runtime remains not-ready and does not run conversion.
3. Run only the installation cell. It clones Seed-VC at commit `51383efd921027683c89e5348211d93ff12ac2a8`, installs Python 3.13-compatible NumPy 2.1.3/SciPy 1.14.1 wheels, and pins Protobuf 6.31.1 to match the TensorFlow-generated code in the current Colab runtime and provide the Transformers/HuBERT runtime API. Descript AudioTools declares an incompatible legacy Protobuf constraint, so the cell installs its runtime dependencies separately and installs the codec wheels without dependency resolution. It reapplies the exact NumPy, SciPy, and Protobuf pins last so ancillary packages cannot replace them.
4. After installation completes, choose **Runtime > Restart session** once to reload packages. Reconnect to T4, then run the GPU/import check. It prints and verifies NumPy 2.1.3, SciPy 1.14.1, and Protobuf 6.31.1; logs each import of the Protobuf runtime API, HuBERT, AudioTools, DAC quantizer, and pinned Seed-VC v2 wrapper; and reports CUDA/GPU status. Do not choose “Run all” before completing this restart.
5. Run the final backend cell. Wait for model initialization and the temporary `gradio.live` URL. The same cell prints a random access code; copy it privately to the frontend operator. The code is generated at launch and is not present in the notebook source. A share URL alone does not prove readiness: the model must load successfully.
6. Keep the Colab tab and runtime alive while the frontend calls the backend. The model downloads its checkpoints from Hugging Face during first startup.

Use this updated notebook, not an already-running older backend. The website requires `/status` to return `pipeline_version: identity-anchored-v3-text-safe` at connection and again before reference upload. Older notebooks are rejected with an update instruction so they cannot silently generate using the previous settings.

The backend preloads the model before reporting ready. `/status` reports `ready: true` only after the submitted access code is valid, CUDA is available, and model initialization succeeded. Every `/generate` request checks the access code, consent, GPU, files, text length, and one-at-a-time lock before starting conversion. Each uploaded reference is decoded to a mono excerpt from at most the first 30 seconds, edge silence is trimmed, and up to 25 seconds is used to match Seed-VC's target-prompt limit. Empty, near-silent or nonfinite reference audio is rejected. Text is limited to 1,200 characters.

## Exact Gradio API

The Blocks event names are intentionally fixed for `@gradio/client`:

- `/status`: one `str` input `access_key`; one JSON output with `ready` (boolean), `gpu` (boolean), `sample_rate` (number), and `message` (string); authorized readiness also includes `pipeline_version` (string).
- `/generate`: inputs in this order: `source_voice` (audio filepath), `accent_reference` (audio filepath), `script` (string, maximum 1,200 characters), `access_key` (string), `consent` (boolean). It returns one audio filepath (a WAV file).

The access code is checked before any conversion call. The backend permits one generation at a time and deletes stage intermediates when the request finishes. Generated WAVs are stored in a temporary output directory with bounded one-hour retention; the cleanup only considers up to 256 old output files and never recursively removes Gradio directories. The output path is therefore temporary too.

## Privacy and safety limits

The `gradio.live` URL is temporary, but anyone who obtains it may be able to submit requests while the Colab process is running. Treat the URL and access code as secrets, do not put the access code in a public client bundle, and stop the Colab runtime when finished. Uploaded reference audio is processed in the Colab VM and passes through Gradio sharing. Only the typed script is sent to the Edge TTS service. Do not use sensitive recordings or text unless that data flow is acceptable. Use only recordings for which the relevant speakers gave permission.

Free Colab GPU access is limited and is not an always-on or private hosting service. No paid API is required, but first startup downloads large model checkpoints and a T4 may still be slow. The earlier three-pass pipeline was intentionally retired because its final pass could erase words. The text-safe v3 changes have passed offline regression tests but still require a live Colab T4 listening comparison. Offline tests do not prove speaker similarity, accent match, or naturalness.

Pronunciation Guard is local to the Colab VM; it does not upload audio to a third-party transcription service. The first stage uses `convert_style=False` to retain content/pronunciation from the accent reference while adapting timbre. The second stage uses `convert_style=True` for each short neutral-TTS segment, guided by the blended prompt and checked against the expected duration. All segments are joined in order; any stage failure is an error, never an intermediate audio fallback. Any stage failure is an error, never an intermediate audio fallback. Finite generated samples are checked and excessive peaks are scaled proportionally before PCM WAV writing rather than hard-clipped. This cannot fix model artifacts. Status checks are unqueued; generation has explicit progress stages and a 20 MB Gradio upload cap.
