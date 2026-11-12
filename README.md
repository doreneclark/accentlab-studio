# AccentLab Studio

AccentLab Studio is a mobile-friendly, experimental two-reference voice workspace. Supply an authorized original speaker recording, a French-accented English reference, and exact new words. The website can start or reuse an eligible free Google Colab T4 runtime through managed Google OAuth, or use the manual notebook workflow below, and returns only the model’s actual converted WAV. This is a separate managed website; existing deployments are left untouched until the new site is verified.

## Use the connection

Download `client/public/accentlab_seedvc_backend.ipynb` from the website. Open Google Colab, upload the notebook, select **Runtime → Change runtime type → T4 GPU**, and run the first installation cell. When it completes, restart the Colab session once so the updated numerical and Protobuf packages load cleanly. After reconnecting to T4, run the GPU/import check and then the backend launch cell; do not use “Run all” before completing that restart. When model loading finishes, the launch cell prints a temporary `https://…gradio.live` URL and a random session access code. Enter both in AccentLab Studio and choose **Check connection**. Keep Colab running.

Upload the original voice and target-accent samples, write your script, confirm that both speakers have given permission, then select **Generate voice preview**. After the notebook returns a converted WAV, you can play it and download it. Start with short scripts. Files are limited to 20 MB each and the notebook uses short reference excerpts. Free GPUs are availability-limited and sessions can expire; reconnect using the new URL and code after a restart.

## Fidelity and privacy

Identity-plus-accent transfer is a two-stage approximation, not a guaranteed voice clone. Listen carefully for speaker drift, pronunciation errors, and unnatural output. Microsoft’s Edge speech service receives the script to make a temporary neutral TTS scaffold; Seed-VC, not the scaffold, produces the final converted output. Reference audio and results pass through Gradio sharing and are processed in the temporary Colab VM. Do not use sensitive material. Only use recordings whose speakers explicitly consented.

The URL and access code are kept only in the browser page’s memory, not in a public bundle or local storage. The backend validates the code before GPU conversion. This is a personal experimental tool, not an authenticated multi-user production voice service. The temporary share endpoint and its files are not a substitute for private hosting; stop the runtime when finished.

## Development

Use the pinned package manager: `npx pnpm@10.18.0 install --frozen-lockfile`. `pnpm dev:static` serves the browser app on port 3000; `pnpm build:static` creates `dist/public` for static publication. `pnpm check` runs TypeScript diagnostics and `pnpm test` runs the tests, including mocked transport checks for the Colab connector. Python model dependencies are installed by the notebook in Colab, not required for hosting the static website.

`client/src/lib/colab.ts` owns Gradio transport, validation, queue events, cancellation, result checks, and local downloads. `client/src/pages/Home.tsx` owns the interface. `colab/` owns the GPU backend; the public notebook embeds the same backend source. `plan.md` records the accepted design and continuation assumptions. Live inference and voice/accent quality can only be validated in an active CUDA Colab runtime; passing local transport tests does not establish a successful model conversion.
