# AccentLab plan

## Product goal

AccentLab is a private reference-voice text-to-speech workspace. The user uploads an original voice recording to preserve speaker identity, uploads a second target-accent recording to guide pronunciation and intonation, types new words, and receives a generated recording that follows the source speaker’s vocal identity while adopting the target accent as closely as the connected speech-to-speech provider allows.

## Implementation approach

The first version is a single-page React experience served by the existing React/Express starter. The UI has three stages: provide the source voice and target-accent pair, write the new message, and generate/listen/download the result. Source and accent audio are kept in the browser for preview until a real provider is connected. The app does not silently use a different fixed TTS voice. A future provider adapter will receive both recordings or stored reference IDs, the transcript, and delivery controls, then return an audio URL or bytes.

The current project has server capability but no custom voice-cloning provider configured. The UI therefore makes that dependency explicit with an honest “provider connection required” state. The project now also includes a free Google Colab/Gradio backend notebook using an experimental two-stage Seed-VC approximation. The interface and request shape are ready for the temporary Colab endpoint or a later persistent GPU provider.

## Design direction

### Style candidates

1. Editorial audio instrument — probability 0.07
2. Soft clinical utility — probability 0.04
3. Dark creator dashboard — probability 0.06

### Chosen style: Editorial audio instrument

- **Design Movement:** Swiss editorial systems meet a quiet recording studio.
- **Core Principles:** calm hierarchy, visible audio provenance, deliberate pacing, and zero ambiguity between source voice and written script.
- **Color Philosophy:** parchment and ink create trust and focus; a single electric-coral accent marks the active recording/generation action.
- **Layout Paradigm:** a narrow left rail for the voice imprint, a large writing surface in the center, and a compact output tray on the right; on mobile these become a vertical sequence.
- **Signature Elements:** a coral “signal dot,” thin waveform-like dividers, and numbered stage markers.
- **Interaction Philosophy:** every destructive or irreversible action is avoided; upload, preview, and generation states are explicit.
- **Animation:** small opacity and translate transitions only; a slow signal pulse during processing; no decorative motion that competes with recording status.
- **Typography System:** Space Grotesk for display and labels, IBM Plex Mono for metadata and file details, system sans for body copy.
- **Brand Essence:** “Write it once. Hear it in the voice you know.” Quiet, precise, human.
- **Brand Voice:** direct and reassuring. Example lines: “Your voice is the reference.” “Write the next line below.”
- **Wordmark / Logo:** an outlined sound-wave loop next to the AccentLab wordmark.
- **Signature Brand Color:** electric coral `#ef6b5d`.

## Project structure

- `client/src/pages/Home.tsx`: the complete three-stage workspace and local audio state.
- `client/src/index.css`: AccentLab design tokens, layout, typography and responsive behavior.
- `client/src/lib/colab-progress.ts`: safe managed-progress JSON parsing and HTTP/network diagnostics without exposing proxy bodies or arbitrary browser exception text.
- `server/colab-api.ts`: Google OAuth, free-T4 eligibility, safe runtime start/reuse and private progress routes.
- `server/colab-bootstrap.ts` and `colab/api_bootstrap_worker.py`: synchronized bounded installer/model launch payloads and the private Colab worker.
- `server/routers.ts`: future tRPC boundary for a provider-backed generation job.
- `server/_core/index.ts`: health and runtime server entry.
- `public/manus-routes.json`: route manifest for the root page.
- `TODO.md`: delivery outcomes and provider integration blocker.

## Colab connection continuation — November 7, 2026

Replace the placeholder Generate action with the official `@gradio/client` browser adapter. The user starts a free Colab GPU notebook, copies its temporary HTTPS Gradio URL and session access code into AccentLab, and checks connectivity before uploading the two references. Connection settings and the access code remain in memory only. The browser sends the two files, new text, access code, and explicit speaker-permission consent directly to the notebook's `/generate` endpoint; `/status` checks readiness without uploading recordings. Queued progress, useful failures, cancellation of listening, local audio preview, and WAV download complete the flow. No Hugging Face token or paid service is required for this Colab path.

The notebook loads the actual Seed-VC interface, checks CUDA availability, and exposes versioned, named endpoints. The two-stage identity/accent approximation remains experimental; neither uploads nor health checks imply that identity was preserved. Intermediate neutral text-to-speech is disclosed and is never returned as the claimed converted result. Recordings are processed on the Colab runtime and travel through the temporary Gradio sharing service. The share URL and access code must not be shared; this is not a production private hosting system.

The uploaded ZIP is an exported source snapshot. It does not grant editing/publication access to the original Manus website resource. Deliver a corrected source ZIP if resource access remains unavailable; do not represent offline source changes as a published website update. Live GPU and output-quality validation require an active user-started Colab runtime.

Additional modules: `client/src/lib/colab.ts` owns the transport, input limits, lifecycle, and result checks. `server/colab.test.ts` exercises that adapter without model inference. `colab/` and the public notebook contain the self-contained GPU setup and backend.

## Approved new-project delivery

The original resource was inaccessible in this session. The user explicitly approved importing the corrected source into a separate managed Web project, preserving the old deployment. The project serves the React frontend from `dist/public` and a managed Express API for Google OAuth and Colab orchestration. The managed database remains disabled. Colab GPU use is Free-tier T4 only; managed web-server hosting is separate. An explicit checkpoint and publication provide a new website link.

The user clarified that microphone-recording controls were not requested. Keep the original upload-only reference flow; do not add `getUserMedia`, `MediaRecorder`, or recorder buttons. Files can be locally previewed before use. The backend takes only the first 30 seconds of each uploaded reference.

The first Seed-VC stage runs with `convert_style=False` to adapt the French-accent recording toward the source speaker's timbre without the AR target-style rewrite. The second runs with `convert_style=True` to guide newly spoken words from the blended prompt. This remains unvalidated for exact identity/accent quality. The frontend displays real conversion progress and returns playback only after a same-origin downloaded WAV passes header checks. GPU model dependencies are installed in Colab, not on the static website host.

## Approved Colab API launch continuation — November 8, 2026

The user approved a button that safely starts or reuses an AccentLab-owned Colab runtime, runs the backend, retrieves the temporary Gradio URL/access code, and fills the existing connection fields. They explicitly approved one-way managed server enablement after disclosure that web-server hosting is separate from free Colab GPU use. Keep the database disabled, retain upload-only references and the manual connector, and do not add Signal file sharing disguised as native voice notes. Managed server capability is enabled.

Use Google's official `colaboratory.googleapis.com` API, not private Colab browser endpoints. A Google Web OAuth client registered for AccentLab and the `https://www.googleapis.com/auth/colaboratory` scope are required. The existing session's Drive connector is not an application OAuth grant. Obtain client credentials through the secure project input card only. Use an explicit public callback origin, not a request Host-derived origin; bind authorization state to the initiating browser, keep provider tokens out of frontend code and logs, and use HTTPS HttpOnly SameSite=None cookies with expiry. No database or unattended token retention is required for a user-initiated launch.

Before any runtime allocation, require the API to return exactly `SUBSCRIPTION_TIER_FREE` and an eligible standard T4 GPU spec. Do not change subscriptions, enable Google Cloud billing, fall back to another GPU, or silently bypass a failed check. If account permissions, availability, quotas, API setup or eligibility fail, explain the failure and preserve manual startup. A Free tier and eligible hardware are the permitted allocation guard, not a guarantee of availability or of lasting twelve hours. The user selected safe start/reuse: never stop, restart, or delete any runtime. The official runtime API has no restart operation; if an existing runtime has no usable connection, explain how to restart it manually in Colab and never replace an unrelated runtime.

Keep slow model setup in the Colab runtime, not the web server request. Reuse the canonical pinned notebook dependency installation in a clean Python process so imports reload without an interactive kernel restart. Package the canonical backend source; load the model before readiness; capture a new runtime-generated code and actual Gradio share URL without committing them. Use an encrypted, non-secret browser runtime identity that persists across OAuth access-token reauthorization, idempotent runtime creation, bounded authenticated startup status lookups and duplicate-launch prevention. Completion fills the fields, then runs the existing `/status` connector check before declaring connected. Polling observes an actual requested startup, is finite and stops on ready/error/timeout; it is not an idle keep-alive.

Bind bootstrap retries to a signed launch-attempt ID. Only a new explicit start/reuse click can rerun a dead failed worker; the same attempt's progress polling preserves terminal errors, and no live worker is terminated or replaced. Hold the startup lock only for worker registration, not for dependency installation, model loading or the long-lived Gradio server wait. Load Seed-VC from its checkout directory because the pinned wrapper uses repository-relative configuration paths.

The user explicitly approved and selected the separate “Repair & reinstall AccentLab” action with an in-app confirmation. It is distinct from safe start/reuse and implemented as a secondary button. The automatic installer uses a dedicated `/content/accentlab-runtime/seed-vc` checkout, leaving the legacy/manual `/content/seed-vc` untouched. Repair stops only the dedicated AccentLab worker after verifying its exact command path, process-start ticks, and dedicated process group; it sends SIGTERM only and never kills by PID alone or by process name. It removes only that marked managed checkout and allowlisted AccentLab status/worker/backend source files, then reruns the pinned setup. The Colab runtime, notebook, Drive, uploads/generated WAVs, model cache, Python environment and all unrelated files are preserved. If ownership or process identity cannot be proven, repair aborts without deleting anything. Offline tests exercise the verified and mismatched-worker paths. No GPU restart, paid fallback, or broad temporary-directory cleanup.

The small Express backend handles OAuth, free-tier eligibility, runtime launch orchestration and private progress. The existing React UI owns the launch/authorize and confirmed repair controls and displays honest setup, authorization, allocating, installing, loading, ready and error states. Dockerfile and `/api/*` server routing supply hosted API requests while the existing built frontend remains static. The user successfully completed Google authorization on the published site, but the following progress request displayed the generic error “Could not read Colab runtime progress.” The client now exposes only a sanitized HTTP status/content type for non-JSON proxy failures, while server logs record only a safe failure class/status, never tokens, runtime IDs, Gradio URLs or access codes. The actual free-T4 runtime creation, worker readiness, and automatic URL/code population remain unverified; mocked tests do not prove live creation.

## Bounded Colab progress follow-up — November 8, 2026

The live trace showed that the launch request returned HTTP 200, but a later synchronous `/api/colab/progress` call returned proxy HTTP 502 before any connection details were surfaced. Keep Google/Colab provider calls out of browser polling: each progress POST returns the cached, sanitized stage immediately and schedules at most one background provider step per in-memory runtime job. The per-process job cache is capped at 64 entries, prunes expired/quiet terminal entries, and is intentionally not durable because the project database is disabled. The initial `/api/colab/launch` eligibility/allocation request remains synchronous; the observed timeout was in progress polling, so this change does not claim that the initial API call is asynchronous.

Bind jobs to the encrypted session and signed launch token. A safe start after OAuth reauthorization can rebind the same active attempt without changing its repair state; a second repair click is rejected. After process-state loss, safe launches and tokens explicitly marked repair-prepared can rehydrate only after the background step rechecks the Colab Free subscription and exact standard T4. A missing unprepared-repair job returns a safe error and never repeats reset; the user can choose safe start/reuse or the manual notebook. Ready responses alone may contain a validated temporary Gradio endpoint and access code, retained only in ephemeral ready state until pruning or process loss. Colab control JSON is parsed with a 16 KiB route-specific limit before the shared upload-friendly parser; provider/MCP response bodies are streamed with a 1 MiB cap. Audio is never handled by this queue; Google access tokens are used only by the currently scheduled request closure and are not retained in cache entries. No durable orchestration or credential storage is introduced.

Offline coverage includes slow-provider nonblocking polls, single-step scheduling, launch serialization, Free/T4 rechecks, safe restart rehydration, prepared-repair recovery, fail-closed unprepared-repair loss, OAuth reauthorization, credential sanitization, and response-size caps. At this stage the v2 comparison is still not complete: the previously approved repair returned 200 at launch, but the progress poll failed before readiness, and no v2 audio conversion was submitted. Live quality and worker readiness remain unverified.

Official sources: https://developers.google.com/colab/api/reference/rest ; https://developers.google.com/colab/api/reference/rest/v1beta/runtimespecs/list ; https://developers.google.com/colab/api/reference/rest/v1beta/TopLevel/getSubscription ; https://developers.google.com/colab/api/reference/mcp ; https://developers.google.com/identity/protocols/oauth2/web-server .

## Source-identity priority continuation — November 8, 2026

The user asked to refine future outputs rather than clean or overwrite the prior WAV. Keep source identity and target accent roles separate, and preserve the exact script. For the explicitly consented comparison, the original-speaker and French-accent references are sent only through the approved Colab/Gradio conversion path; the text script is sent to Edge TTS as temporary scaffold speech. No personal model is trained and no paid GPU is used.

Keep the experimental three-pass identity-anchored pipeline. First adapt the accent reference toward the original speaker without AR style conversion. Next generate the new script toward that blended prompt with AR style conversion. Finally convert the new speech directly toward the real original-speaker reference with AR style conversion disabled. That last pass is intended to re-anchor timbre while retaining the already generated linguistic content and accent; it is not a guarantee that accent, naturalness or identity will be preserved. The v2 quality trial uses 50 diffusion steps and similarity guidance 0.93 for accent-to-source adaptation, 0.80 for the blended-script pass, and 0.95 for the final source anchor. Intelligibility guidance stays at 0.7 and AR sampling stays at top-p 0.7, temperature 0.7, and repetition penalty 1.5. These settings are an unmeasured experiment, not a speaker similarity score. Do not substitute an unrelated TTS speaker for a converted output or claim a guaranteed improvement.

Prepare references with leading/trailing silence trimmed and at most 25 seconds of usable prompt context to match the pinned wrapper limit. Reject empty or near-silent references; avoid aggressive denoising, pitch shifting, or rewriting the user's exact script. Retain finite-output checks and proportionally scale peaks above the safe ceiling instead of hard-clipping generated audio before WAV export. These guardrails do not repair model errors.

Advertise `pipeline_version: identity-anchored-v2` in authorized `/status` responses and require it in the website connector before accepting any generation. Older notebooks receive an explicit download-and-restart instruction rather than silently continuing the old pipeline. Keep the five-input `/generate` contract unchanged. Synchronize the Python backend, downloadable notebook and automatic-launch bootstrap sources. The upload-only page explains source-identity priority, extra runtime cost, and experimental tradeoffs. The v1 path was tested once with the user-consented references and the user reported improvement over the first result; the v2 settings still require a fresh T4 comparison. Offline tests establish stage routing and compatibility, not audible quality.

Seed-VC settings and semantics: https://github.com/Plachtaa/seed-vc ; https://raw.githubusercontent.com/Plachtaa/seed-vc/51383efd921027683c89e5348211d93ff12ac2a8/modules/v2/vc_wrapper.py .
