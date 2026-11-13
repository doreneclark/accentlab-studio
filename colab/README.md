# AccentLab Studio Colab backend

This folder contains the canonical experimental backend for AccentLab Studio. It uses the pinned upstream Seed-VC v2 model on an eligible free Google Colab T4. The current AccentLab application pipeline is `identity-anchored-v5-expressive-text-safe`: it retains the v3 two-pass text-safe core and v4 expression controls, and makes laugh/giggle samples optional. The old “v2 quality trial” in earlier TODO notes referred to a separate, unverified three-pass AccentLab experiment; it did not mean Seed-VC upstream v2.

The existing text-safe path first adapts the French-accent reference toward the original speaker without AR style rewrite. It then converts short scaffolded script segments toward that blended prompt. The old final source-anchoring pass stays removed because it could erase words. The Pronunciation Guard locally transcribes each converted speech segment, retries one definite mismatch with safer settings, and returns no speech when verification is uncertain or still fails. These choices prioritize exact wording; they do not prove greater speaker similarity or naturalness than the old untested idea.

## Expression cues

Insert `[mood:neutral]`, `[mood:playful]`, `[mood:excited]`, `[mood:sad]`, or `[mood:calm]` into the script. A mood applies to following speech until another mood tag. The tags are removed before TTS and word verification. The temporary Edge-TTS scaffold receives small rate/pitch changes only; the shift is approximate and is not a named-emotion synthesis feature. Write your own joke or line and mark where it should feel playful. AccentLab does not rewrite scripts or infer joke timing.

`[laugh]` and `[giggle]` insert the supplied original-speaker laugh/giggle clip when one is provided; that clip is optional, and an unsampled cue is skipped rather than synthesized. `[sob]` requires the supplied original-speaker cry/sob clip. Selected clips are reused rather than generated or represented as cloned sounds. Event samples use the accepted audio formats, have the existing 20 MB limit, and are trimmed/capped to eight seconds. They are processed in the temporary Colab job and sent only when the script contains a matching cue. They do not enter the word-recognition comparison.

Do not treat the user’s 85–95% similarity goal as a measured score or promise. No real-speaker listening comparison has established such a score. Listen to each output against the permitted references and report limitations honestly.

## Run the notebook manually

1. Open [`accentlab_seedvc_backend.ipynb`](./accentlab_seedvc_backend.ipynb) in Google Colab and select **Runtime → Change runtime type → T4 GPU**.
2. Run only the installation cell. When it completes, restart the session once so the compatible packages load.
3. Reconnect to T4 and run the GPU/import check. Then run the backend launch cell. Do not choose “Run all” before restarting.
4. Wait until the model is ready. Copy the temporary `gradio.live` URL and random access code into AccentLab Studio. Keep both private and keep Colab running.

The installer pins Seed-VC commit `51383efd921027683c89e5348211d93ff12ac2a8`. It uses Python 3.13-compatible NumPy 2.1.3/SciPy 1.14.1 wheels and Protobuf 6.31.1 for the current Colab runtime, then preflights the pinned wrapper imports. A share URL alone is not readiness; model initialization and CUDA/T4 checks must pass.

## API contract

The named endpoints remain `/status` and `/generate`. Authorized `/status` responses include `ready`, `gpu`, `sample_rate`, `message`, and `pipeline_version`; the website requires `identity-anchored-v5-expressive-text-safe` at connection and again before upload. Older v3 and v4 notebooks are rejected with an update instruction so a stale worker cannot silently re-require an optional laugh clip.

`/generate` accepts seven inputs in order: `source_voice` filepath, `accent_reference` filepath, `script` string (maximum 1,200 characters including tags), `access_key` string, `consent` boolean, optional `laugh_sample` filepath, and optional `sob_sample` filepath. A matching laugh/giggle sample may be omitted, in which case its cue is skipped; a matching sob sample is required for `[sob]`. An unused sample is `None`. Consent covers both references and any event sample from the original speaker. The backend validates authorization, CUDA, consent, all file size/format constraints, cue/sample matching, and the one-job lock before conversion.

## Data handling and safety

The URL is temporary but public to anyone who obtains it while the Colab process is running; treat it and the access code as secrets. Audio is processed through Gradio sharing in the temporary runtime. The script is sent to Microsoft Edge-TTS to create the scaffold. Temporary intermediates are removed when the request finishes; generated WAVs use bounded one-hour retention. If the runtime or job is lost, the current app cannot resume from an intermediate chunk; a retry starts the entire take again. Do not use sensitive text or audio, and use only recordings for which the speakers have permissioned this processing.

Free Colab availability, usage limits, and termination timing vary. The app does not use paid GPU fallback, an alternate provider, or a keepalive/restart workaround to evade free-runtime controls. Managed OAuth start/reuse and manual notebook connection use the same synchronized backend. The narrowly gated Preview request-origin exception does not relax strict production origin checking.

## Synchronizing code

Edit `accentlab_seedvc_backend.py` as the canonical model backend, then run `pnpm sync:colab` from the repository root. It updates the notebook's embedded source and guidance, the public notebook copy, the automatic worker's embedded backend, and the TypeScript managed-bootstrap payload. It deliberately preserves the managed worker's separate repair-aware installer and T4 preflight. The manual notebook installs and preflights `/content/seed-vc`; the managed worker installs and preflights the same ownership-marked `/content/accentlab-runtime/seed-vc` checkout. Keep those paths paired: the managed worker runs its own preflight, while TypeScript's canonical manual-preflight string mirrors the notebook. A focused AST regression protects the managed install/preflight path agreement. Run `pnpm check:colab-sync` before a checkpoint to confirm the generated backend copies still match. `pnpm test`, `pnpm check`, and `pnpm build` cover the app and offline backend/request-flow guardrails. They cannot establish subjective likeness, accent quality, or naturalness.
