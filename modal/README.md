# AccentLab Modal worker (local template only)

This folder contains a local deployment template for the existing canonical Seed-VC v5 backend. It has **not** been deployed, and no Modal account, proxy token, budget, payment, GPU runtime, or generation was created. Colab remains the default; Hugging Face remains unchanged.

## How the request path is protected

The AccentLab server requires a verified Google identity matching the server-side `MODAL_CONTROL_ALLOWED_EMAIL` allowlist, a same-origin request, and a CSRF token before it forwards an upload. The Modal server URL and proxy token never go to the browser. The deployed ASGI endpoint has `requires_proxy_auth=True`; Modal's edge requires the `Modal-Key` and `Modal-Secret` pair before it reaches the T4 function. The T4 function is limited to one container and one concurrent input, with a 60-second idle scale-down window and a 20-minute request timeout. No GPU is queried when the page loads or when the owner session is checked.

The worker uses the canonical `colab/accentlab_seedvc_backend.py` and the same pinned Seed-VC installer as the existing Hugging Face template. Incoming audio is limited to 20 MB per file and 84 MB total. The temporary source files are deleted when the request ends; the generated output is removed after it is returned. The worker has no persistent volume, so model weights are downloaded into an ephemeral runtime after it scales up. This makes first use slower and may repeat that download after the worker scales to zero. Stop-listening in the browser stops waiting; it cannot promise that an already-started remote inference job stops immediately. There is no automatic retry.

## Before deploying

Create a Modal account at [modal.com/signup](https://modal.com/signup?next=%2Fapps). **Do not deploy until both account controls are visibly set and confirmed:**

1. Set the Workspace **usage budget to $10/month**. Modal documents this as a cap on gross usage before credits.
2. Set the Workspace **spend limit to $10/month** as a separate cap on net out-of-pocket charges after credits.

If either hard control is unavailable or cannot be set to $10, stop before deploying. Modal currently lists $30/month in Starter compute credits; these are credits, not a $10 purchase or a substitute for the $10 gross usage budget. T4, CPU, memory, and network are metered separately. Confirm the account's current billing controls and the effect of credits before proceeding. See [Modal budgets](https://modal.com/docs/guide/budgets) and [Modal pricing](https://modal.com/pricing).

After budgets are active, install the Modal CLI locally and authenticate it with the user's account. Then create a Modal Proxy Token intended only for this private endpoint, and deploy from the repository root:

```bash
python -m pip install -r modal/requirements.txt
modal setup
modal deploy modal/app.py
```

Deployment builds a container but does not issue an inference request. Do not test the endpoint until the budgets and proxy-token requirement are verified. Copy the deployed private endpoint URL and the proxy token ID/secret into the AccentLab **server-side secrets only**; never put them in client variables or source control. Configure these website secrets:

- `MODAL_ENDPOINT_URL` — the deployed base URL ending in `.modal.run` (no path).
- `MODAL_PROXY_KEY` and `MODAL_PROXY_SECRET` — the Modal proxy token pair.
- `MODAL_CONTROL_ALLOWED_EMAIL` — the one authorized Google email. Do not store it in this repository.
- `GOOGLE_COLAB_CLIENT_ID` and `GOOGLE_COLAB_CLIENT_SECRET` — the existing OAuth client secrets already used by the app.

The Modal login reuses the app's existing callback URI, `/api/colab/oauth/callback`, and requests only OpenID/email identity. The allowlist is checked on the server. Do not expose any Modal key, secret, OAuth secret, or owner email to the browser.

## Local checks

From the repository root, syntax-check the deployment template without connecting to Modal:

```bash
python -m py_compile modal/app.py huggingface-space/install_deps.py
```

The ordinary `pnpm check`, `pnpm test`, and `pnpm build` checks validate the website/server integration. They do not deploy or start a GPU. A real T4 inference and voice-quality test still require a later, separately approved deployment and request.
