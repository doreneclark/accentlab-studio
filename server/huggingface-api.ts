import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { parse as parseCookie } from "cookie";
import type {
  Express,
  NextFunction,
  Request,
  Response as ExpressResponse,
} from "express";
import {
  withHuggingFaceLeaseLock,
  type HuggingFaceLeaseLock,
  type HuggingFaceLeaseRecord,
} from "./db";

export const HUGGINGFACE_STATE_COOKIE = "accentlab_hf_oauth_state";
const HUGGINGFACE_SESSION_COOKIE = "accentlab_hf_owner_session";
const HUGGINGFACE_CALLBACK_PATH = "/api/colab/oauth/callback";
const HUGGINGFACE_API_ORIGIN = "https://huggingface.co";
const T4_SMALL_HOURLY_USD = 0.4;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_HTTP_MS = 20_000;
const GENERATION_LEASE_MS = 60 * 60 * 1000;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<globalThis.Response>;

interface OAuthState {
  v: 1;
  state: string;
  verifier: string;
  exp: number;
}

interface OwnerSession {
  v: 1;
  csrfToken: string;
  email: string;
  exp: number;
}

interface SpaceRuntime {
  stage?: unknown;
  hardware?: unknown;
  requested_hardware?: unknown;
  [key: string]: unknown;
}

export interface HuggingFaceApiOptions {
  clientId?: string;
  clientSecret?: string;
  token?: string;
  spaceId?: string;
  spaceAccessKey?: string;
  allowedEmail?: string;
  fetch?: FetchLike;
  now?: () => number;
  allowInsecureCookies?: boolean;
  allowMissingOrigin?: boolean;
  allowPreviewProxyOrigin?: boolean;
  leaseLock?: HuggingFaceLeaseLock;
}

function base64url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function keyFor(secret: string): Buffer {
  return createHash("sha256")
    .update("accentlab-huggingface-owner-cookie-v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `${base64url(iv)}.${base64url(encrypted)}.${base64url(cipher.getAuthTag())}`;
}

function open<T>(value: string | undefined, secret: string): T | undefined {
  if (!value) return undefined;
  try {
    const [ivText, encryptedText, tagText, extra] = value.split(".");
    if (!ivText || !encryptedText || !tagText || extra !== undefined)
      return undefined;
    const iv = fromBase64url(ivText);
    const encrypted = fromBase64url(encryptedText);
    const tag = fromBase64url(tagText);
    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      encrypted.length > MAX_BODY_BYTES
    )
      return undefined;
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as T;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cookieValue(req: Request, name: string): string | undefined {
  try {
    return parseCookie(req.headers.cookie ?? "")[name];
  } catch {
    return undefined;
  }
}

function cookieOptions(allowInsecure: boolean, maxAge?: number) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: allowInsecure ? ("lax" as const) : ("none" as const),
    secure: !allowInsecure,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function setCookie(
  res: ExpressResponse,
  name: string,
  value: string,
  allowInsecure: boolean,
  maxAge: number
): void {
  res.cookie(name, value, cookieOptions(allowInsecure, maxAge));
}

function clearCookie(
  res: ExpressResponse,
  name: string,
  allowInsecure: boolean
): void {
  res.clearCookie(name, cookieOptions(allowInsecure));
}

function safeString(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function configuredSpaceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(
    value
  );
}

function spaceUrl(spaceId: string): string {
  return `https://${spaceId.replace("/", "-")}.hf.space`;
}

function seconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

function appOrigin(req: Request): string {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const host =
    (typeof forwardedHost === "string" && forwardedHost.split(",")[0].trim()) ||
    (typeof req.headers.host === "string" && req.headers.host.trim());
  const proto =
    (typeof forwardedProto === "string" &&
      forwardedProto.split(",")[0].trim().toLowerCase()) ||
    (req.protocol === "http" ? "http" : "https");
  return `${proto}://${host || "localhost"}`;
}

function originAllowed(
  req: Request,
  allowMissing: boolean,
  allowPreviewProxyOrigin: boolean
): boolean {
  const origin = req.headers.origin;
  const expected = appOrigin(req);
  if (origin === expected) return true;
  const forwardedHost =
    typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"].split(",")[0].trim()
      : "";
  const forwardedProto =
    typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0].trim().toLowerCase()
      : "";
  const previewOrigin =
    allowPreviewProxyOrigin &&
    origin === "http://127.0.0.1:3000" &&
    req.headers.host === "127.0.0.1:3000" &&
    forwardedProto === "https" &&
    forwardedHost.length > 0 &&
    expected === `https://${forwardedHost}` &&
    forwardedHost.endsWith(".manus.computer");
  return previewOrigin || (allowMissing && origin === undefined);
}

function bodyIsSmall(req: Request): boolean {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES)
      return false;
  }
  return (
    Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") <= MAX_BODY_BYTES
  );
}

function safeError(
  res: ExpressResponse,
  status: number,
  message: string
): void {
  res
    .set("Cache-Control", "no-store")
    .status(status)
    .json({ error: message.replace(/[\r\n]/g, " ").slice(0, 240) });
}

async function readJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  op: string
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_HTTP_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* response can already be closed */
      }
      throw new Error(`${op} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error(`${op} response too large`);
    return text.trim() ? (JSON.parse(text) as unknown) : {};
  } finally {
    clearTimeout(timer);
  }
}

function stageFor(
  runtime: SpaceRuntime
): "paused" | "starting" | "ready" | "error" {
  const stage = String(runtime.stage ?? "").toUpperCase();
  if (stage === "PAUSED") return "paused";
  if (stage === "RUNNING_APP") return "ready";
  if (stage.includes("ERROR") || stage.includes("STOPPED")) return "error";
  if (
    stage.includes("BUILD") ||
    stage.includes("RUNNING") ||
    stage.includes("START") ||
    stage.includes("WAIT")
  )
    return "starting";
  return "error";
}

function isT4Small(runtime: SpaceRuntime): boolean {
  const requested = String(runtime.requested_hardware ?? "").toLowerCase();
  const current = String(runtime.hardware ?? "").toLowerCase();
  const matches = (value: string) =>
    /(?:^|[-_])t4[-_]small(?:$|[-_])/.test(value);
  const reported = [requested, current].filter(Boolean);
  return reported.length > 0 && reported.every(matches);
}

function parseRuntime(value: unknown): SpaceRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Space runtime response.");
  return value as SpaceRuntime;
}

export function registerHuggingFaceApiRoutes(
  app: Express,
  options: HuggingFaceApiOptions = {}
): void {
  const clientId = (
    options.clientId ??
    process.env.GOOGLE_COLAB_CLIENT_ID ??
    ""
  ).trim();
  const clientSecret = (
    options.clientSecret ??
    process.env.GOOGLE_COLAB_CLIENT_SECRET ??
    ""
  ).trim();
  const token = (options.token ?? process.env.HUGGINGFACE_TOKEN ?? "").trim();
  const spaceId = (
    options.spaceId ??
    process.env.HUGGINGFACE_SPACE_ID ??
    ""
  ).trim();
  const spaceAccessKey = (
    options.spaceAccessKey ??
    process.env.HUGGINGFACE_SPACE_ACCESS_KEY ??
    ""
  ).trim();
  const allowedEmail = (
    options.allowedEmail ??
    process.env.HF_CONTROL_ALLOWED_EMAIL ??
    ""
  )
    .trim()
    .toLowerCase();
  const fetcher: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const allowInsecureCookies = options.allowInsecureCookies === true;
  const configured = Boolean(
    clientId &&
      clientSecret &&
      token &&
      spaceAccessKey &&
      allowedEmail &&
      configuredSpaceId(spaceId)
  );
  const leaseLock = options.leaseLock ?? withHuggingFaceLeaseLock;

  const readOwnerSession = (req: Request): OwnerSession | undefined => {
    const session = open<OwnerSession>(
      cookieValue(req, HUGGINGFACE_SESSION_COOKIE),
      clientSecret
    );
    if (
      !session ||
      session.v !== 1 ||
      !safeString(session.email, 320) ||
      !safeString(session.csrfToken, 256) ||
      !Number.isFinite(session.exp) ||
      session.exp <= seconds(now) + 2
    )
      return undefined;
    return session;
  };

  const csrfFor = (req: Request, session: OwnerSession) =>
    typeof req.headers["x-accentlab-hf-csrf"] === "string" &&
    req.headers["x-accentlab-hf-csrf"] === session.csrfToken;

  const ownerOnly: (
    req: Request,
    res: ExpressResponse,
    next: NextFunction
  ) => void = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !configured ||
      !originAllowed(
        req,
        options.allowMissingOrigin === true,
        options.allowPreviewProxyOrigin === true
      ) ||
      !bodyIsSmall(req)
    ) {
      safeError(
        res,
        403,
        "Hugging Face controls are not configured or request is invalid."
      );
      return;
    }
    const session = readOwnerSession(req);
    if (!session || session.email.toLowerCase() !== allowedEmail) {
      safeError(
        res,
        401,
        "Authorized Google account required for Hugging Face controls."
      );
      return;
    }
    if (!csrfFor(req, session)) {
      safeError(res, 403, "Invalid Hugging Face request token.");
      return;
    }
    res.locals.huggingFaceSession = session;
    next();
  };

  app.get("/api/huggingface/oauth/start", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!configured) {
      res.redirect(302, "/?hf_auth=unavailable");
      return;
    }
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const exp = seconds(now) + 10 * 60;
    setCookie(
      res,
      HUGGINGFACE_STATE_COOKIE,
      seal({ v: 1, state, verifier, exp } satisfies OAuthState, clientSecret),
      allowInsecureCookies,
      10 * 60 * 1000
    );
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${appOrigin(req)}${HUGGINGFACE_CALLBACK_PATH}`,
      response_type: "code",
      scope: "openid email",
      state,
      access_type: "online",
      prompt: "select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get(HUGGINGFACE_CALLBACK_PATH, async (req, res) => {
    const stateCookie = cookieValue(req, HUGGINGFACE_STATE_COOKIE);
    if (!stateCookie) return;
    res.set("Cache-Control", "no-store");
    clearCookie(res, HUGGINGFACE_STATE_COOKIE, allowInsecureCookies);
    if (!configured) {
      res.redirect(302, "/?hf_auth=unavailable");
      return;
    }
    const statePayload = open<OAuthState>(stateCookie, clientSecret);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (
      !statePayload ||
      statePayload.v !== 1 ||
      statePayload.exp <= seconds(now) ||
      state !== statePayload.state ||
      !code ||
      code.length > 4096
    ) {
      res.redirect(302, "/?hf_auth=error");
      return;
    }
    try {
      const tokenResponse = await readJson(
        fetcher,
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${appOrigin(req)}${HUGGINGFACE_CALLBACK_PATH}`,
            grant_type: "authorization_code",
            code_verifier: statePayload.verifier,
          }).toString(),
        },
        "Google identity token exchange"
      );
      const accessToken =
        tokenResponse && typeof tokenResponse === "object"
          ? safeString(
              (tokenResponse as Record<string, unknown>).access_token,
              4096
            )
          : undefined;
      if (!accessToken)
        throw new Error("Google did not return an access token.");
      const identity = await readJson(
        fetcher,
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        },
        "Google identity lookup"
      );
      const email =
        identity && typeof identity === "object"
          ? safeString(
              (identity as Record<string, unknown>).email,
              320
            )?.toLowerCase()
          : undefined;
      const verified =
        identity &&
        typeof identity === "object" &&
        (identity as Record<string, unknown>).email_verified === true;
      if (!email || !verified)
        throw new Error("Google email was not verified.");
      const expiresIn =
        tokenResponse &&
        typeof tokenResponse === "object" &&
        typeof (tokenResponse as Record<string, unknown>).expires_in ===
          "number"
          ? ((tokenResponse as Record<string, unknown>).expires_in as number)
          : 3600;
      const exp = seconds(now) + Math.max(60, Math.min(8 * 60 * 60, expiresIn));
      const csrfToken = base64url(randomBytes(24));
      setCookie(
        res,
        HUGGINGFACE_SESSION_COOKIE,
        seal(
          { v: 1, email, csrfToken, exp } satisfies OwnerSession,
          clientSecret
        ),
        allowInsecureCookies,
        Math.max(60_000, (exp - seconds(now)) * 1000)
      );
      res.redirect(302, "/?hf_auth=success");
    } catch {
      res.redirect(302, "/?hf_auth=error");
    }
  });

  app.get("/api/huggingface/session", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = readOwnerSession(req);
    const authorized = Boolean(
      configured && session && session.email.toLowerCase() === allowedEmail
    );
    if (!authorized) {
      res.json({
        configured,
        authorized: false,
        priceUsdPerHour: T4_SMALL_HOURLY_USD,
        message: configured
          ? "Authorize the allowlisted Google account to control the Hugging Face worker."
          : "Hugging Face is not configured. Its optional fallback is unavailable until its protected server settings and an existing Space are set.",
      });
      return;
    }
    let runtime: SpaceRuntime | undefined;
    let message = "Space runtime status checked.";
    try {
      runtime = parseRuntime(
        await readJson(
          fetcher,
          `${HUGGINGFACE_API_ORIGIN}/api/spaces/${spaceId}/runtime`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
          },
          "Space runtime status"
        )
      );
    } catch {
      message =
        "Could not check the Hugging Face Space status. No compute was started.";
    }
    const state = runtime ? stageFor(runtime) : "error";
    let lease: HuggingFaceLeaseRecord;
    try {
      lease = await leaseLock(session!.email.toLowerCase(), async access => {
        const current = access.get();
        if (current.state === "active" && state === "paused") {
          const idle: HuggingFaceLeaseRecord = {
            state: "idle",
            generationId: "",
            expiresAt: 0,
          };
          await access.save(idle);
          return idle;
        }
        if (current.state === "pausing" && state === "paused") {
          const idle: HuggingFaceLeaseRecord = {
            state: "idle",
            generationId: "",
            expiresAt: 0,
          };
          await access.save(idle);
          return idle;
        }
        return current;
      });
    } catch {
      safeError(
        res,
        503,
        "Shared HF safety state is unavailable. No connection credentials or control action were released."
      );
      return;
    }
    const generationActive = lease.state === "active";
    const generationLeaseExpired = generationActive && lease.expiresAt <= now();
    const pausePending = lease.state === "pausing";
    res.json({
      configured,
      authorized: true,
      csrfToken: session!.csrfToken,
      stage: state,
      hardware: runtime?.requested_hardware ?? runtime?.hardware ?? null,
      t4Small: Boolean(runtime && isT4Small(runtime)),
      generationActive,
      generationLeaseExpired,
      ...(generationActive ? { generationId: lease.generationId } : {}),
      pausePending,
      ...(generationActive
        ? { generationLeaseExpiresAt: lease.expiresAt }
        : {}),
      priceUsdPerHour: T4_SMALL_HOURLY_USD,
      message: generationActive
        ? generationLeaseExpired
          ? "The safety lease expired, but the generation may still be running. Pause is blocked until the owner verifies it has ended or Hugging Face reports the Space paused."
          : "A generation safety lease is active; pause and new generations are blocked until it ends."
        : pausePending
          ? "Pause is pending; new generations remain blocked until Hugging Face reports the Space paused."
          : runtime && state === "ready"
            ? "Space is running; checking the v5 inference endpoint is still required."
            : runtime && state === "paused"
              ? "Space is paused. It is not using compute."
              : message,
      ...(runtime && state !== "error"
        ? { spaceUrl: spaceUrl(spaceId), accessKey: spaceAccessKey }
        : {}),
    });
  });

  const hfRequest = async (
    path: string,
    method: "POST" | "GET"
  ): Promise<unknown> =>
    readJson(
      fetcher,
      `${HUGGINGFACE_API_ORIGIN}/api/spaces/${spaceId}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      "Space control"
    );

  app.post("/api/huggingface/start", ownerOnly, async (req, res) => {
    try {
      const session = res.locals.huggingFaceSession as OwnerSession;
      await leaseLock(session.email.toLowerCase(), async access => {
        const previous = access.get();
        if (previous.state === "active") {
          safeError(
            res,
            409,
            previous.expiresAt <= now()
              ? "The generation lease expired, but the job may still be active. Verify it ended before changing Space state."
              : "A generation may still be active; wait before changing Space state."
          );
          return;
        }
        if (previous.state === "pausing") {
          const pendingRuntime = parseRuntime(
            await hfRequest("runtime", "GET")
          );
          if (stageFor(pendingRuntime) !== "paused") {
            safeError(
              res,
              409,
              "The Space pause is still pending; no start request was made."
            );
            return;
          }
          await access.save({ state: "idle", generationId: "", expiresAt: 0 });
        }
        const current = parseRuntime(await hfRequest("runtime", "GET"));
        if (!isT4Small(current)) {
          safeError(
            res,
            409,
            "The configured Space is not confirmed as T4-small. No hardware changes or start request were made."
          );
          return;
        }
        const currentStage = stageFor(current);
        if (currentStage === "ready" || currentStage === "starting") {
          res.json({
            stage: currentStage,
            message: "Space is already running or starting.",
          });
          return;
        }
        if (currentStage !== "paused") {
          safeError(
            res,
            409,
            "Space is not in a confirmed paused state; no start request was made."
          );
          return;
        }
        if (req.body?.confirmation !== "HF_T4_SMALL_040_PER_HOUR") {
          safeError(
            res,
            400,
            "Confirm the displayed T4-small price before starting the Space."
          );
          return;
        }
        parseRuntime(await hfRequest("restart", "POST"));
        res.json({
          stage: "starting",
          message: "Hugging Face accepted the explicit start request.",
        });
      });
    } catch {
      safeError(
        res,
        503,
        "Shared HF safety state or runtime check failed; no safe start was confirmed. No token or provider response was returned."
      );
    }
  });

  app.post("/api/huggingface/pause", ownerOnly, async (_req, res) => {
    const session = res.locals.huggingFaceSession as OwnerSession;
    let shouldRequestPause = false;
    try {
      await leaseLock(session.email.toLowerCase(), async access => {
        const previous = access.get();
        if (previous.state === "active") {
          safeError(
            res,
            409,
            previous.expiresAt <= now()
              ? "The generation lease expired, but the job may still be active. Verify it ended before pausing."
              : "A generation may still be active. Wait for it to finish before pausing."
          );
          return;
        }
        const current = parseRuntime(await hfRequest("runtime", "GET"));
        if (!isT4Small(current)) {
          safeError(
            res,
            409,
            "The configured Space is not confirmed as T4-small; it was not paused."
          );
          return;
        }
        if (stageFor(current) === "paused") {
          await access.save({ state: "idle", generationId: "", expiresAt: 0 });
          res.json({ stage: "paused", message: "Space is already paused." });
          return;
        }
        if (previous.state === "pausing") {
          res.json({
            stage: "pausing",
            message: "A Hugging Face pause request is already pending.",
          });
          return;
        }
        await access.save({ state: "pausing", generationId: "", expiresAt: 0 });
        shouldRequestPause = true;
      });
      if (!shouldRequestPause) return;
      const result = parseRuntime(await hfRequest("pause", "POST"));
      const confirmedPaused = stageFor(result) === "paused";
      if (confirmedPaused) {
        await leaseLock(session.email.toLowerCase(), async access => {
          if (access.get().state === "pausing")
            await access.save({
              state: "idle",
              generationId: "",
              expiresAt: 0,
            });
        });
      }
      res.json({
        stage: confirmedPaused ? "paused" : "pausing",
        message: confirmedPaused
          ? "Hugging Face confirmed the Space paused."
          : "Hugging Face accepted the pause request; new generations remain blocked until the Space reports paused.",
      });
    } catch {
      safeError(
        res,
        503,
        "Shared HF safety state or pause check failed. The Space remains blocked from new generations until status is confirmed."
      );
    }
  });

  app.post(
    "/api/huggingface/generation/start",
    ownerOnly,
    async (_req, res) => {
      const session = res.locals.huggingFaceSession as OwnerSession;
      const key = session.email.toLowerCase();
      try {
        await leaseLock(key, async access => {
          const currentLease = access.get();
          if (currentLease.state === "active") {
            safeError(
              res,
              409,
              currentLease.expiresAt <= now()
                ? "An expired generation lease still requires owner verification before another generation."
                : "A Hugging Face generation may still be active."
            );
            return;
          }
          if (currentLease.state === "pausing") {
            const pending = parseRuntime(await hfRequest("runtime", "GET"));
            if (stageFor(pending) !== "paused") {
              safeError(
                res,
                409,
                "The Space pause is pending; generation was not started."
              );
              return;
            }
          }
          const runtime = parseRuntime(await hfRequest("runtime", "GET"));
          if (!isT4Small(runtime) || stageFor(runtime) !== "ready") {
            safeError(
              res,
              409,
              "A verified ready T4-small Space is required; no audio was uploaded."
            );
            return;
          }
          const generationId = base64url(randomBytes(24));
          const expiresAt = now() + GENERATION_LEASE_MS;
          await access.save({ state: "active", generationId, expiresAt });
          res.json({ generationId, expiresAt });
        });
      } catch {
        safeError(
          res,
          503,
          "Shared HF safety state is unavailable; no audio was uploaded."
        );
      }
    }
  );

  app.post(
    "/api/huggingface/generation/heartbeat",
    ownerOnly,
    async (req, res) => {
      const session = res.locals.huggingFaceSession as OwnerSession;
      const key = session.email.toLowerCase();
      const id = safeString(req.body?.generationId, 128);
      try {
        await leaseLock(key, async access => {
          const current = access.get();
          if (
            current.state !== "active" ||
            !id ||
            current.generationId !== id ||
            current.expiresAt <= now()
          ) {
            safeError(res, 409, "The generation lease is no longer active.");
            return;
          }
          const expiresAt = now() + GENERATION_LEASE_MS;
          await access.save({ ...current, expiresAt });
          res.json({ generationActive: true, expiresAt });
        });
      } catch {
        safeError(
          res,
          503,
          "Shared HF safety state is unavailable; the lease remains fail-closed."
        );
      }
    }
  );

  app.post("/api/huggingface/generation/clear", ownerOnly, async (req, res) => {
    const session = res.locals.huggingFaceSession as OwnerSession;
    const key = session.email.toLowerCase();
    const id = safeString(req.body?.generationId, 128);
    if (req.body?.confirmation !== "HF_NO_ACTIVE_GENERATION") {
      safeError(
        res,
        400,
        "Confirm that no Hugging Face generation is still running."
      );
      return;
    }
    try {
      await leaseLock(key, async access => {
        const current = access.get();
        if (
          current.state !== "active" ||
          !id ||
          current.generationId !== id ||
          current.expiresAt > now()
        ) {
          safeError(
            res,
            409,
            "The expired generation lease is not eligible for recovery."
          );
          return;
        }
        await access.save({ state: "idle", generationId: "", expiresAt: 0 });
        res.json({
          generationActive: false,
          message: "The owner-confirmed safety lease was cleared.",
        });
      });
    } catch {
      safeError(
        res,
        503,
        "Shared HF safety state is unavailable; the lease remains fail-closed."
      );
    }
  });

  app.post("/api/huggingface/generation/end", ownerOnly, async (req, res) => {
    const session = res.locals.huggingFaceSession as OwnerSession;
    const key = session.email.toLowerCase();
    const id = safeString(req.body?.generationId, 128);
    try {
      await leaseLock(key, async access => {
        const current = access.get();
        if (current.state === "active" && id && current.generationId === id)
          await access.save({ state: "idle", generationId: "", expiresAt: 0 });
        const after = access.get();
        res.json({ generationActive: after.state === "active" });
      });
    } catch {
      safeError(
        res,
        503,
        "Shared HF safety state is unavailable; the lease remains fail-closed."
      );
    }
  });
}

export const __huggingFaceTest = {
  seal,
  open,
  stageFor,
  isT4Small,
  spaceUrl,
  HUGGINGFACE_CALLBACK_PATH,
  HUGGINGFACE_STATE_COOKIE,
  HUGGINGFACE_SESSION_COOKIE,
  T4_SMALL_HOURLY_USD,
};
