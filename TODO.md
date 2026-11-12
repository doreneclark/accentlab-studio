# AccentLab outcomes

## 1. Reference voice setup

- [x] The user can upload an original voice recording as the voice-identity source.
- [x] The user can upload a second French-accented English recording as the target-accent reference.
- [x] The interface labels the two recordings separately: original speaker and target accent.
- [x] The interface shows selected file names and clear replacement actions.
- [x] File limits and allowed formats are checked, and uploads are not treated as proof of identity/accent preservation.

## 2. New script writing

- [x] The user can type the exact words they want spoken in a dedicated writing surface.
- [x] The interface shows a live character count and a short note that punctuation influences pauses.
- [x] Generation is disabled until both uploaded recordings, nonempty script, consent, and a verified Colab connection exist.

## 3. Generation and output states

- [x] The Generate action uploads both references and submits the new text to the actual Colab endpoint rather than displaying a placeholder. A synthetic-only end-to-end run through the website's `ColabConnection` against the live T4 exercised endpoint readiness, reference upload, queueing, both inference stages, output download, and WAV validation.
- [x] Queue/progress, errors, disconnect handling, cancellation of listening, and disabled Gradio browser run-history persistence are explicit and regression-tested.
- [x] A returned converted WAV can be played and downloaded locally after same-origin and WAV-header checks. The live synthetic run returned 16-bit PCM mono at 22,050 Hz, 11.02 seconds, and 485,932 bytes; no real recording or listening-quality evaluation was performed.
- [x] The app never returns a generic intermediate TTS voice as the converted output and clearly labels identity/accent transfer experimental.

## 4. Responsive product shell

- [x] Connection controls and output have mobile and desktop layout rules.
- [x] The route manifest serves the root page at `/` and is verified as JSON over HTTP.
- [x] TypeScript check, application/connector regression tests, and the static production build pass. The earlier full live test was of the previous two-pass pipeline; it is not proof of the new three-pass profile's audio quality.

## 5. Free Colab backend

- [x] The self-contained downloadable notebook uses the actual Seed-VC interface at pinned source revision `51383efd921027683c89e5348211d93ff12ac2a8`, pins Protobuf 6.31.1 to match the TensorFlow-generated code observed in Colab, and replaces upstream NumPy 1.26.4/SciPy 1.13.1 with NumPy 2.1.3/SciPy 1.14.1 for Python 3.13 wheel support. It installs the Descript AudioTools/DAC packages without resolving AudioTools' stale Protobuf constraint, installs their runtime dependencies explicitly, reapplies the pins last, and preflights the actual Seed-VC wrapper import.
- [x] Named status and generation endpoints match the website's five generation inputs: source voice, accent reference, new script, session access code, consent. Verified with actual Gradio 5.23.0 API schema locally.
- [x] A random runtime access code is checked before inference; CUDA and a successfully loaded model are required for readiness. Invalid-key and CUDA-unavailable checks are locally tested.
- [x] Temporary hosting, model limitations, intermediate TTS, and third-party data handling are explained.
- [x] A live readiness check through the same JavaScript client used by the site returned `ready=true`, `gpu=true`, and sample rate 22050 on the Tesla T4.
- [x] The complete live upload-to-WAV path was verified using synthetic references only; no user or real-speaker recording was uploaded. This proves technical flow and WAV validity, not subjective audio quality or identity/accent preservation on a human sample.

## 6. Delivery

- [x] The user authorized importing the ZIP as a separate managed project; copied initialization/resource identity records were excluded and the original site remains unchanged.
- [x] Checkpoint `6b04d90` was saved and publication was confirmed through infrastructure state. The domain is `accentlab2-ii4q5q9z.manus.space`; the site is public to anyone with the link, as requested.

## 7. User-initiated Colab API startup

- [x] The user approved a secure Google OAuth/backend integration and one-way managed server enablement, with separate hosting usage disclosed; database remains disabled.
- [ ] A website button authorizes Google Colab management, safely starts or reuses an AccentLab-owned runtime, executes the pinned backend setup, retrieves the actual generated Gradio URL and session access code, and fills the two existing fields without manual copying. The safe start/reuse button never stops, restarts, or deletes a runtime. Google authorization completed and the latest launch passed the Preview origin guard; the first progress attempt returned HTTP 429, and the one approved safe retry reused an existing free T4 but worker bootstrap failed. No Gradio URL or access code surfaced, the app remains not connected, and no v2 conversion was submitted. The existing background-progress/recovery changes remain in place; live worker readiness and automatic URL/code population are unresolved.
- [x] Runtime allocation fails closed unless Google reports `SUBSCRIPTION_TIER_FREE` and an eligible standard T4 GPU spec. No paid GPU, paid plan, Google Cloud billing activation, alternative hardware fallback, or runtime deletion/replacement is performed. The separate confirmed repair may stop only the verified AccentLab worker and remove only allowlisted, app-managed software/status files; it never restarts or deletes the T4 runtime or touches unrelated processes. The official API has no runtime restart method; if an existing runtime has no usable connection, the UI explains that the user must restart it manually in Colab. Offline route tests cover paid-tier/ineligible-hardware rejection and own-runtime reuse; worker code checks Tesla T4 before model readiness.
- [x] OAuth client credentials and tokens are protected server-side, OAuth state and encrypted session data are bound to the initiating browser, the non-secret runtime identity persists across reauthorization to avoid duplicate T4 creation, privileged requests are authenticated, and session details remain private and absent from repository/logs/client storage. PKCE, encrypted HttpOnly cookies, exact-Origin/CSRF gates, redacted responses and reauthorization identity are regression-tested.
- [x] Startup is idempotent, progress is bounded and truthful, model readiness is checked through the existing connector before connected is shown, and manual startup remains available on permission, setup, availability, quota or startup failure. Offline worker tests prove a new user launch can retry a dead failed worker, polling preserves failures, live workers are not replaced, and the startup lock is released during setup/server wait. Background poll state is process-local (no database); safe reauthorization can resume an active job, safe/prepared work can rehydrate, and lost unprepared repair state never triggers another reset. No idle keep-alive automation is added. Live provider success remains separate below.
- [x] The separate “Repair & reinstall AccentLab” button requires a confirmation every time, and only operates after the user explicitly confirms. It stops only an AccentLab worker whose exact path, process-start identity and dedicated process group are verified; it clears only the marked automatic software checkout and allowlisted AccentLab bootstrap/status/source files, then reinstalls the pinned backend. It preserves the Colab runtime, notebook, Google Drive, uploaded/generated recordings, model cache, Python environment and unrelated files; if ownership or process identity is ambiguous, it aborts without deleting anything. No GPU restart, paid fallback, or broad temporary-directory cleanup is performed. Focused offline tests cover confirmation, exact process verification, SIGTERM-only behavior, abort-on-mismatch and preservation of notebook, audio, cache and legacy checkout. No-follow directory/file operations preserve pre-existing symlink targets, all allowlisted identities are rechecked before any cleanup, and unavailable process identity never triggers a termination signal.
- [x] Progress failures with a non-JSON/non-2xx response show only sanitized HTTP status/content type or a safe network-error category, and backend diagnostics never log OAuth tokens, runtime proxy tokens, Gradio URLs or access codes. The client displays HTTP status/content type when a proxy response is not JSON; server progress logs record only the error class/status. Provider/MCP responses are read with a streaming 1 MiB cap, and Colab control JSON is limited to 16 KiB before the shared upload-friendly parser.
- [x] The Google OAuth client and permitted callback are configured, the Colab API is enabled, client values pass format checks, and Google authorization completed successfully on the published website. Authorization also remained active in the replacement Preview after its server reload; the narrowly gated Preview proxy-origin exception passed, with production origin checking left strict. Worker bootstrap then failed, so do not claim automatic runtime readiness.
- [ ] Deferred until the user asks to resume after they have enough Manus credit: make the initial managed Colab Start or reuse request return a pending response promptly and move Google setup/allocation into the existing background progress flow. Preserve Google authorization and CSRF checks, Free standard T4 only, safe start/reuse, explicit confirmation for repair, no paid/CPU/other-provider fallback, no runtime stop/delete, and no duplicate repair. Show quota denials clearly without automatic retry. This may reduce website timeouts caused by slow launch calls; it cannot change Google Colab GPU availability or usage limits. Do not implement until the user asks to resume.

## 8. Future results prioritize the original speaker

- [x] Refine AccentLab's future conversion pipeline rather than cleaning or overwriting the previous result. For the user-approved test, the two consented reference recordings went through Colab/Gradio and the exact supplied script went to Edge TTS as temporary scaffold speech; no personal model was trained, and the original reference/result files were left untouched.
- [x] The final conversion directly uses the real original-speaker upload as its target identity reference, while the separate French-accent upload still guides the newly written script; retain the exact script, five-input contract, speaker consent and free-Colab-only workflow. Offline mocked stage-routing tests confirm the third-pass target and settings; they are not speaker-quality evidence.
- [x] Use the refined v2 trial settings: 50 diffusion steps, similarity guidance 0.93 for accent-to-source adaptation, 0.80 for blended script conversion, and 0.95 for final source anchoring. Keep the exact five-input API, reject empty/near-silent references, return no intermediate audio on failure, and never use a paid fallback. Offline routing/numerical/pass-3 failure regressions pass; the values are experimental and not measured similarity scores.
- [x] The canonical Python backend, downloadable notebook and automatic-launch bootstrap are synchronized. The frontend checks `identity-anchored-v2` at connection and again before uploading, rejecting older notebooks with a clear update instruction. Connector and notebook/bootstrap parity tests pass offline.
- [x] The upload-only interface explains source-identity priority, extra processing time and experimental limits without promising identical voice, measured similarity or guaranteed improvement.
- [ ] A new consented live T4 v2 comparison demonstrates closer speaker identity and naturalness with the real reference recordings. V1 was generated from the consented samples and the user said it was better than the first result, but v2 settings remain unverified until a new live generation and user listening comparison; offline tests cannot prove quality.

## 9. Pronunciation Guard for text fidelity
- [x] Every generated speech chunk is transcribed locally inside the Colab runtime with the installed `faster-whisper` `tiny.en` model and compared case-insensitively after punctuation normalization against the exact requested words.
- [x] Definite missing, repeated, unexpected, or substituted words cause only the affected chunk to be regenerated once with safer Seed-VC settings (`40` diffusion steps, `0.65` similarity guidance, `1.2` repetition penalty); the entire script and already verified chunks are not regenerated.
- [x] Low-confidence or unavailable verification fails closed with an honest message and returns no unverified or partial WAV. A completed output is returned only after every chunk passes verification and the existing duration guard.
- [x] Progress reports verification and retry states, and the feature remains compatible with the upload-only five-input flow, free Colab T4 backend, manual connector, and automatic bootstrap.
- [x] Offline fidelity coverage includes punctuation normalization, missing words, repeated words, substitutions, uncertainty handling, chunk-local retry settings, and synchronized canonical/notebook/worker/bootstrap sources. A live human-recording quality comparison remains unverified until a T4 run is available.
