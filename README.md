# AccentLab Studio

AccentLab Studio is a mobile-friendly, experimental two-reference voice workspace. Supply an authorized original-speaker recording and a separate French-accented English reference, write the exact new words, and add explicit mood or vocalization cues if useful. The site can start or reuse an eligible free Google Colab T4 through protected Google OAuth, or use the manual notebook workflow below. It returns only the verified converted WAV. This replacement project leaves older deployments and repositories untouched until they are independently verified and intentionally cleaned up.

## Use AccentLab Studio

For managed setup, authorize Google from the app and choose **Start or reuse free T4**. For manual setup, download `client/public/accentlab_seedvc_backend.ipynb`, open it in Google Colab, select **Runtime → Change runtime type → T4 GPU**, run the installation cell, restart once, run the GPU check, then run the backend cell. When the model reports ready, paste the temporary Gradio URL and access code into the app. Keep the Colab tab open.

Upload the original voice and target-accent recordings, write the exact words, and confirm you have permission to process the recordings through temporary Colab and Gradio sessions. The script can contain `[mood:neutral]`, `[mood:playful]`, `[mood:excited]`, `[mood:sad]`, or `[mood:calm]`; each mood continues until the next mood cue. Use `[laugh]` or `[giggle]` to insert a short laugh/giggle recorded by the original speaker, and `[sob]` to insert that speaker’s cry/sob recording. Matching event samples are required only when used and are uploaded only with a matching cue. Each audio file is limited to 20 MB. References use up to 25 seconds; event clips are capped to eight seconds.

The app does not write jokes or infer where a joke should go. Write your own words and mark their desired delivery. Mood shifts are approximate, using small pitch/rate changes to the temporary speech scaffold. Laughs, giggles, and sobs are inserted from the speaker sample, not newly synthesized. The 85–95% voice-similarity goal has not been validated as a score and is not guaranteed.

## Fidelity and privacy

The current `identity-anchored-v4-expressive-text-safe` app pipeline retains the text-safe v3 two-pass baseline and adds expression cues. It uses the pinned Seed-VC upstream v2 model; those version numbers describe different things. Pronunciation Guard checks each generated speech segment locally before the app returns a WAV. Identity, accent, naturalness, and likeness remain experimental and need a real-speaker listening comparison.

Microsoft Edge-TTS receives the script to make a temporary scaffold; Seed-VC must produce the converted speech. References, any event sample used, and generated files pass through Gradio sharing in the temporary Colab runtime. Anyone with the live share URL may be able to submit requests. Treat the URL and access code as secrets, do not use sensitive material, and use only recordings whose speakers authorized this processing. The URL and code are held only in the page’s memory, not in the public client bundle or local storage.

## Development and account continuity

Use the pinned package manager: `npx pnpm@10.18.0 install --frozen-lockfile`. `pnpm dev` runs the website and server; `pnpm build` creates the production app. `pnpm check` runs TypeScript diagnostics and `pnpm test` runs the offline regression tests.

`colab/accentlab_seedvc_backend.py` is the canonical Python backend. After changing it, run `pnpm sync:colab` to regenerate the manual notebook and managed worker/bootstrap copies. Run `pnpm check:colab-sync` before committing. `plan.md` records the accepted scope and design; `TODO.md` retains completed history and unresolved follow-ups. A local test does not prove live T4 availability or subjective voice likeness.

For the current Webdev project UID, GitHub and Drive backup status, open validation items, and safe cross-account continuation guidance, see [HANDOFF.md](HANDOFF.md). It contains no protected secret values.
