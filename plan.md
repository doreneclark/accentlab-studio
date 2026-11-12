# AccentLab Studio implementation plan

## Product goal

AccentLab Studio is an experimental two-reference voice workspace. The user supplies the original speaker recording for identity reference and a separate French-accented English recording for accent guidance, writes exact new words, confirms permission, connects a free Google Colab T4 either manually or with Google OAuth-managed start/reuse, then plays or downloads a WAV. Keep the existing consent, readiness/version checks, Pronunciation Guard, cancellation, progress, error handling, output validation, TODO history, and safe Colab rules. Never silently change providers, use paid/CPU fallback, start/stop/delete an unrelated runtime, or remove unrelated speech functionality.

## Pipeline comparison and selection

Three similar version labels had become mixed together. `identity-anchored-v3-text-safe` is the AccentLab application pipeline currently required by the browser. It uses the pinned upstream Seed-VC v2 model. The old “v2 quality trial” in the inherited TODO describes an AccentLab three-pass experiment, not the upstream model version. The deployed source currently contains a two-pass implementation, and its final direct-to-source re-anchoring pass was removed because it could erase requested words.

The current two-pass v3 is the safer baseline for this request because it protects the exact script with chunked conversion and Pronunciation Guard. That is a text-fidelity decision, not proof that v3 sounds more like the original speaker. The old three-pass idea may help speaker anchoring, but it has no verified human A/B result and may lose words. Keep v3; do not restore the unverified third pass or state that either option achieves 85–95% voice similarity. Actual similarity and naturalness remain subject to an authorized, same-reference listening comparison.

The pinned Seed-VC v2 README says its `convert_style` option uses the autoregressive model for accent and emotion conversion. It does not document a per-label control API for directives such as “playful” or “crying.” The official Edge-TTS project states custom SSML support was removed and exposes rate, volume, and pitch prosody controls instead. Accordingly, expression controls are an experimental, small rate/pitch adjustment to the existing temporary speech scaffold; they are not a promise of human-level acting. For audible laughter, giggles, and sobs, use short optional vocalization clips recorded by the same original speaker and insert those clips at explicit script cues. This keeps the actual non-speech sound authentic to that speaker without claiming the model invented or cloned it. [Seed-VC pinned README](https://github.com/Plachtaa/seed-vc/blob/51383efd921027683c89e5348211d93ff12ac2a8/README.md) [Edge-TTS prosody controls](https://github.com/rany2/edge-tts#changing-rate-volume-and-pitch) [Edge-TTS SSML limitation](https://github.com/rany2/edge-tts#custom-ssml)

## Expression authoring and generation

Retain the existing 1,200-character script field and add compact cue buttons that insert explicit tags at the current caret. `[mood:neutral]`, `[mood:playful]`, `[mood:excited]`, `[mood:sad]`, and `[mood:calm]` set the delivery for following spoken text until the next mood tag. `[laugh]` and `[giggle]` request a short, optional same-speaker laugh/giggle sample at that point. `[sob]` requests a short, optional same-speaker cry/sob sample. A user writes their own joke and chooses where to mark delivery; AccentLab does not rewrite the script or guess jokes automatically.

The parser removes recognized control tags before TTS and ASR. Spoken segments retain their mood value, use only conservative Edge-TTS rate/pitch settings, then pass through the existing two-pass v3 conversion and pronunciation checks. Vocalization events are prepared as mono audio and inserted in script order; they are not sent through TTS or counted as spoken words. A laugh/giggle event requires its uploaded source-speaker sample, and a sob event requires its uploaded source-speaker sample. Samples are optional when the script has no matching event, bounded by the existing per-file size policy and a new short-duration cap, uploaded only for a generation that uses them, and kept in the runtime's temporary work directory. Consent copy must cover these added samples. The site will disclose that rate/pitch changes are approximate, reference events are inserted rather than synthesized, and no numerical speaker-similarity score is guaranteed.

Update the Gradio request contract and version to `identity-anchored-v4-expressive-text-safe`, then synchronize the canonical Python backend, manual notebook, and OAuth-managed bootstrap source. Old v3 notebooks must receive the existing clear update/reconnect instruction rather than an incomplete or silently downgraded result. Preserve both connection paths, the exact original/accent roles, source and accent uploads, explicit consent, free-T4-only managed rules, and the existing OAuth origin guard.

## Technical shape

The React/Vite client remains a responsive one-page editor. `client/src/pages/Home.tsx` owns uploads, script/cue authoring, consent, connection controls, progress, and playback. A focused client utility owns cue parsing, spoken-text extraction, and required sample detection. `client/src/lib/colab.ts` owns versioned transport, optional vocalization upload, input limits, lifecycle, and returned-WAV validation. The Python backend in `colab/accentlab_seedvc_backend.py` owns canonical parsing, reference preparation, Edge-TTS rate/pitch selection, Seed-VC conversion, event insertion, chunk-level pronunciation verification, and temporary cleanup. `colab/accentlab_seedvc_backend.ipynb`, `colab/api_bootstrap_worker.py`, and `server/colab-bootstrap.ts` carry synchronized notebook and managed-start payloads. The manual notebook intentionally uses `/content/seed-vc`; the ownership-marked managed worker installs and preflights `/content/accentlab-runtime/seed-vc`, and those managed paths must agree. Keep its repair-aware ownership/cleanup logic separate from the manual notebook and preserve it. `HANDOFF.md` records the project identity and continuity guidance without secrets. Existing tests must remain and gain focused parser, request-contract, event-order, missing-sample, and synchronization coverage.

`server/colab-api.ts` continues to handle Google OAuth, strict production request-origin checks, the narrowly gated development Preview proxy exception, free-T4 eligibility, and safe start/reuse. `client/src/index.css` extends the existing Editorial audio instrument style for cue chips and optional expression-sample cards. `client/public/manus-routes.json` declares the root route `/`. Do not add a database, paid inference service, persistent audio storage, microphone recording, or new credential.

## Design direction

Retain the approved existing AccentLab Studio style; do not restyle the product to add emotion cues.

- **Design Movement:** Swiss editorial systems meet a quiet recording studio.
- **Core Principles:** calm hierarchy, visible audio provenance, deliberate pacing, and zero ambiguity between source voice and written script.
- **Color Philosophy:** parchment and ink create trust and focus; electric coral highlights the active recording/generation action and selected expressive cues.
- **Layout Paradigm:** a narrow left rail for the voice imprint, a large writing surface in the center, and a compact output tray on the right; on mobile these become a vertical sequence.
- **Signature Elements:** coral signal dot, thin waveform dividers, and numbered stage markers. Cue tags should be compact and readable, not decorative.
- **Interaction Philosophy:** cues are explicit and reversible; samples are visibly tied to the original speaker; missing required event samples are explained before upload or generation.
- **Animation:** retain small opacity/translate transitions and a slow processing pulse; never animate expressive controls in a way that implies the model understands emotion automatically.
- **Typography System:** Space Grotesk for display and labels, IBM Plex Mono for metadata and file details, system sans for body copy.
- **Brand Essence:** “Write it once. Hear it in the voice you know.” Quiet, precise, human.
- **Brand Voice:** direct and reassuring. Examples: “Your voice is the reference.” “Mark the moment; keep every spoken word yours.”
- **Wordmark / Logo:** retain the outlined sound-wave loop next to the AccentLab wordmark.
- **Signature Brand Color:** electric coral `#ef6b5d`.

## Existing safety and service constraints

The Manus-managed database stays disabled. Google OAuth credentials remain protected server-side. Google Colab uses only an eligible Free-tier standard T4; no paid fallback, billing activation, runtime stop/restart/delete, broad repair cleanup, or alternate GPU is added. Manual notebook/URL/access-code connection remains available when managed OAuth or startup fails. The temporary Gradio URL and generated access code stay private and are never committed or logged. Audio is processed temporarily through Colab and Gradio, not presented as private production hosting. Preserve project and TODO history and leave unrelated repositories, websites, Drive files, and recordings untouched.
