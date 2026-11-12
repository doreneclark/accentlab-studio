# Colab backend research notes

## Official Seed-VC source verification

The backend pins the fetched official repository commit `51383efd921027683c89e5348211d93ff12ac2a8`. The checkout was cloned from the official repository and verified locally with `git rev-parse HEAD`.

- Official repository README: https://github.com/Plachtaa/seed-vc
  - The repository identifies v2 `hubert-bsqvae-small` as the Voice & Accent Conversion model with a 22,050 Hz output sampling rate.
  - Its v2 command-line usage documents intelligibility/similarity CFG rates, `convert-style`, sampling controls, and automatic checkpoint downloads.
  - The README says zero-shot reference speech is 1–30 seconds and recommends a GPU for conversion.
- Pinned v2 inference source: https://raw.githubusercontent.com/Plachtaa/seed-vc/51383efd921027683c89e5348211d93ff12ac2a8/inference_v2.py
  - Official loading path: Hydra `instantiate` of `configs/v2/vc_wrapper.yaml`, then `load_checkpoints`, `.to(device)`, `.eval()`, and `setup_ar_caches(...)`.
  - The source calls `convert_voice_with_streaming(...)` and collects each yielded `(mp3_bytes, full_audio)` pair. The final `full_audio` is `(sample_rate, numpy_audio)`, which the backend preserves when writing WAV.
- Pinned v2 wrapper: https://raw.githubusercontent.com/Plachtaa/seed-vc/51383efd921027683c89e5348211d93ff12ac2a8/modules/v2/vc_wrapper.py
  - The exact supported parameter is misspelled upstream as `intelligebility_cfg_rate`; the backend uses that spelling rather than inventing a corrected keyword.
  - `convert_voice_with_streaming` clips the target/reference waveform to 25 seconds and returns streaming chunks whose final full result contains the wrapper sample rate.
  - `convert_style=True` activates the upstream AR style/accent conversion path; the final implementation enables it only for the second stage.
- Pinned v2 config: https://raw.githubusercontent.com/Plachtaa/seed-vc/51383efd921027683c89e5348211d93ff12ac2a8/configs/v2/vc_wrapper.yaml
  - The config target is `modules.v2.vc_wrapper.VoiceConversionWrapper`, with `sr: 22050` and the official v2 CFM/AR/content/style/vocoder components.
- Official dependency list: https://raw.githubusercontent.com/Plachtaa/seed-vc/51383efd921027683c89e5348211d93ff12ac2a8/requirements.txt
  - The notebook installs this list after excluding its torch/torchvision/torchaudio lines so it can use Colab’s CUDA torch rather than blindly replacing the runtime’s GPU stack.

## Gradio contract and deployment facts

- Gradio API guide: https://www.gradio.app/guides/querying-gradio-apps-with-curl
  - Gradio event API names are called through `/call/<api_name>` by clients; file inputs are represented as filepath/file data and file outputs are returned as file data.
  - The backend therefore uses explicit Blocks event names `api_name="status"` and `api_name="generate"`, with filepath audio components and a JSON status output.
- Google Colab FAQ: https://research.google.com/colaboratory/faq.html
  - Free Colab GPU access is availability/session limited and is not an always-on service. The repository sandbox has no CUDA GPU, so live model download and conversion were not validated here.
- Edge TTS project: https://github.com/rany2/edge-tts
  - The backend treats Edge TTS as a temporary neutral content scaffold. Edge TTS saves MP3 output; the backend decodes it with pydub/ffmpeg, exports a valid mono 22,050 Hz WAV, and removes the MP3 intermediate.

## Implementation decisions

The two stages are deliberately described as an approximation: (1) convert the French-accent reference toward the original voice prompt with `convert_style=False` to retain the source-accent content; (2) convert neutral TTS of the new script toward that blended prompt with the same official v2 streaming API. This does not guarantee perfect identity/accent transfer or disentangle the two attributes at model level.

A random access code is generated at process launch and only printed to the Colab owner. `/status` reveals readiness only after the submitted code is valid, and `/generate` authenticates before any conversion call. CUDA is required, references are limited to 30 seconds at the endpoint, text is limited to 1,200 characters, and a process lock allows one generation at a time. Intermediate stage files are held in `TemporaryDirectory` and removed automatically. Final WAVs use bounded one-hour retention in a dedicated temporary directory so Gradio outputs are not destroyed by a broad cleanup.

## Browser connection implementation

The website uses the pinned npm package `@gradio/client` 2.7.2 rather than hand-constructing Gradio's file and queue protocol. Official JavaScript guide: https://www.gradio.app/guides/getting-started-with-the-js-client. API reference: https://www.gradio.app/docs/js-client. These document `Client.connect(httpsUrl)`, named endpoint inspection, `handle_file(File)` uploads, queued `submit()` status/data events, and cancellation of listening. The uploaded code snapshot initially had no network submission in its Generate handler; that placeholder is replaced by the named `/status` and `/generate` adapter.

Final compatibility checks: a local isolated Gradio 5.23.0 installation instantiated the actual Blocks schema with GPU imports stubbed, confirmed `/status` input `access_key` and `/generate` inputs `source_voice, accent_reference, script, access_key, consent`, and verified invalid-key and CUDA-unavailable readiness behavior. CUDA inference remains untested. Installation now explicitly includes requests, aborts on subprocess errors, preserves an existing modified checkout, and uses the pinned repository working directory.
