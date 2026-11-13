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
import { Readable, Transform } from "node:stream";

export const MODAL_STATE_COOKIE = "accentlab_modal_oauth_state";
export const MODAL_SESSION_COOKIE = "accentlab_modal_owner_session";
export const MODAL_CALLBACK_PATH = "/api/colab/oauth/callback";

const MAX_BODY_BYTES = 84 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_HTTP_MS = 20 * 60 * 1000;
const GOOGLE_HTTP_MS = 20_000;
const CALLBACK_ORIGIN = "https://accounts.google.com";
const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ModalFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { duplex?: "half" }
) => Promise<globalThis.Response>;

export interface ModalApiOptions {
  clientId?: string;
  clientSecret?: string;
  allowedEmail?: string;
  endpointUrl?: string;
  proxyKey?: string;
  proxySecret?: string;
  fetch?: ModalFetch;
  now?: () => number;
  allowInsecureCookies?: boolean;
  allowMissingOrigin?: boolean;
  allowPreviewProxyOrigin?: boolean;
}

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
    .update("accentlab-modal-owner-cookie-v1\0", "utf8")
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
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length > 16 * 1024)
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

function safeString(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
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

function normalizeModalEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "";
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9][a-z0-9-]*\.modal\.run$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    return "";
  return url.origin;
}

function seconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

function sendError(
  res: ExpressResponse,
  status: number,
  message: string
): void {
  res
    .set("Cache-Control", "no-store")
    .set("X-Content-Type-Options", "nosniff")
    .status(status)
    .json({ error: message.replace(/[\r\n]/g, " ").slice(0, 240) });
}

async function readJson(
  fetcher: ModalFetch,
  url: string,
  init: RequestInit,
  label: string
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_HTTP_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !body || typeof body !== "object")
      throw new Error(`${label} failed.`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function modalSessionPayload(
  configured: boolean,
  session: OwnerSession | undefined,
  allowedEmail: string,
  message?: string
) {
  const authorized = Boolean(
    configured && session && session.email.toLowerCase() === allowedEmail
  );
  return {
    configured,
    authorized,
    ...(authorized ? { csrfToken: session!.csrfToken } : {}),
    ...(message ? { message } : {}),
  };
}

export function registerModalApiRoutes(
  app: Express,
  options: ModalApiOptions = {}
): void {
  const clientId = (
    options.clientId ?? process.env.GOOGLE_COLAB_CLIENT_ID ?? ""
  ).trim();
  const clientSecret = (
    options.clientSecret ?? process.env.GOOGLE_COLAB_CLIENT_SECRET ?? ""
  ).trim();
  const allowedEmail = (
    options.allowedEmail ?? process.env.MODAL_CONTROL_ALLOWED_EMAIL ?? ""
  )
    .trim()
    .toLowerCase();
  const endpointUrl = normalizeModalEndpoint(
    options.endpointUrl ?? process.env.MODAL_ENDPOINT_URL ?? ""
  );
  const proxyKey = (options.proxyKey ?? process.env.MODAL_PROXY_KEY ?? "").trim();
  const proxySecret = (
    options.proxySecret ?? process.env.MODAL_PROXY_SECRET ?? ""
  ).trim();
  const fetcher: ModalFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const allowInsecureCookies = options.allowInsecureCookies === true;
  const configured = Boolean(
    clientId &&
      clientSecret &&
      allowedEmail &&
      endpointUrl &&
      proxyKey &&
      proxySecret &&
      !/[\r\n]/.test(proxyKey) &&
      !/[\r\n]/.test(proxySecret)
  );

  const readOwnerSession = (req: Request): OwnerSession | undefined => {
    const session = open<OwnerSession>(
      cookieValue(req, MODAL_SESSION_COOKIE),
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
      )
    ) {
      req.resume();
      sendError(res, 403, "Modal controls are not configured or request is invalid.");
      return;
    }
    const session = readOwnerSession(req);
    if (!session || session.email.toLowerCase() !== allowedEmail) {
      req.resume();
      sendError(res, 401, "Authorized Google account required for Modal generation.");
      return;
    }
    if (req.headers["x-accentlab-modal-csrf"] !== session.csrfToken) {
      req.resume();
      sendError(res, 403, "Invalid Modal request token.");
      return;
    }
    res.locals.modalOwnerSession = session;
    next();
  };

  app.get("/api/modal/oauth/start", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!configured) {
      res.redirect(302, "/?modal_auth=unavailable");
      return;
    }
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const exp = seconds(now) + 10 * 60;
    res.cookie(
      MODAL_STATE_COOKIE,
      seal({ v: 1, state, verifier, exp } satisfies OAuthState, clientSecret),
      {
        ...cookieOptions(allowInsecureCookies),
        maxAge: 10 * 60 * 1000,
      }
    );
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${appOrigin(req)}${MODAL_CALLBACK_PATH}`,
      response_type: "code",
      scope: "openid email",
      state,
      access_type: "online",
      prompt: "select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.redirect(302, `${CALLBACK_ORIGIN}/o/oauth2/v2/auth?${params}`);
  });

  app.get(
    MODAL_CALLBACK_PATH,
    async (req, res, next: NextFunction) => {
      const stateCookie = cookieValue(req, MODAL_STATE_COOKIE);
      if (!stateCookie) {
        next();
        return;
      }
      res.set("Cache-Control", "no-store");
      res.clearCookie(MODAL_STATE_COOKIE, cookieOptions(allowInsecureCookies));
      if (!configured) {
        res.redirect(302, "/?modal_auth=unavailable");
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
        res.redirect(302, "/?modal_auth=error");
        return;
      }
      try {
        const tokenResponse = (await readJson(
          fetcher,
          GOOGLE_TOKEN_URL,
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
              redirect_uri: `${appOrigin(req)}${MODAL_CALLBACK_PATH}`,
              grant_type: "authorization_code",
              code_verifier: statePayload.verifier,
            }).toString(),
          },
          "Google identity token exchange"
        )) as Record<string, unknown>;
        const accessToken = safeString(tokenResponse.access_token, 4096);
        if (!accessToken) throw new Error("Google access token unavailable.");
        const identity = (await readJson(
          fetcher,
          GOOGLE_USERINFO_URL,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          },
          "Google identity lookup"
        )) as Record<string, unknown>;
        const email = safeString(identity.email, 320)?.toLowerCase();
        if (
          !email ||
          identity.email_verified !== true ||
          email !== allowedEmail
        ) {
          res.redirect(302, "/?modal_auth=unauthorized");
          return;
        }
        const expiresIn =
          typeof tokenResponse.expires_in === "number"
            ? tokenResponse.expires_in
            : 3600;
        const sessionExpiry =
          seconds(now) + Math.max(60, Math.min(8 * 60 * 60, expiresIn));
        const csrfToken = base64url(randomBytes(24));
        res.cookie(
          MODAL_SESSION_COOKIE,
          seal(
            { v: 1, email, csrfToken, exp: sessionExpiry } satisfies OwnerSession,
            clientSecret
          ),
          {
            ...cookieOptions(allowInsecureCookies),
            maxAge: Math.max(60_000, (sessionExpiry - seconds(now)) * 1000),
          }
        );
        res.redirect(302, "/?modal_auth=success");
      } catch {
        res.redirect(302, "/?modal_auth=error");
      }
    }
  );

  app.get("/api/modal/session", (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = readOwnerSession(req);
    res.json(
      modalSessionPayload(
        configured,
        session,
        allowedEmail,
        configured
          ? undefined
          : "Modal is unavailable until protected owner-auth and endpoint settings are configured."
      )
    );
  });

  app.post("/api/modal/generate", ownerOnly, async (req, res) => {
    const contentType = req.headers["content-type"] ?? "";
    if (!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType)) {
      req.resume();
      sendError(res, 415, "Expected a multipart audio-generation request.");
      return;
    }
    const declaredLength = req.headers["content-length"];
    if (typeof declaredLength === "string") {
      const parsed = Number(declaredLength);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_BODY_BYTES) {
        req.resume();
        sendError(res, 413, "Audio request exceeds the 84 MB limit.");
        return;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_HTTP_MS);
    const abortOnDisconnect = () => controller.abort();
    req.once("aborted", abortOnDisconnect);
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let totalBytes = 0;
    let tooLarge = false;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          tooLarge = true;
          callback(new Error("request_body_limit"));
          return;
        }
        callback(null, chunk);
      },
    });
    req.pipe(limiter);

    try {
      const webBody = Readable.toWeb(limiter) as ReadableStream<Uint8Array>;
      const response = await fetcher(`${endpointUrl}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          ...(typeof declaredLength === "string"
            ? { "Content-Length": declaredLength }
            : {}),
          "Modal-Key": proxyKey,
          "Modal-Secret": proxySecret,
          Accept: "audio/wav",
        },
        body: webBody,
        duplex: "half",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const status = response.status === 401 || response.status === 403 ? 503 : 502;
        sendError(
          res,
          status,
          status === 503
            ? "Modal rejected the protected worker credentials. The service is unavailable until its server settings are corrected."
            : "Modal could not complete this conversion. The worker may be starting or temporarily unavailable."
        );
        return;
      }
      const upstreamType = response.headers.get("content-type") ?? "";
      if (!/^audio\/(?:wav|wave|x-wav)(?:\s*;|$)/i.test(upstreamType)) {
        await response.body?.cancel().catch(() => undefined);
        sendError(res, 502, "Modal returned an invalid audio response.");
        return;
      }
      const responseLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(responseLength) && responseLength > MAX_OUTPUT_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        sendError(res, 502, "Modal output exceeds the 100 MB safety limit.");
        return;
      }
      if (!response.body) {
        sendError(res, 502, "Modal returned an empty audio response.");
        return;
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputBytes += value.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          await reader.cancel().catch(() => undefined);
          sendError(res, 502, "Modal output exceeds the 100 MB safety limit.");
          return;
        }
        chunks.push(Buffer.from(value));
      }
      const audio = Buffer.concat(chunks, outputBytes);
      if (
        audio.length < 12 ||
        audio.toString("ascii", 0, 4) !== "RIFF" ||
        audio.toString("ascii", 8, 12) !== "WAVE"
      ) {
        sendError(res, 502, "Modal did not return a valid WAV recording.");
        return;
      }
      res
        .status(200)
        .set("Cache-Control", "no-store")
        .set("X-Content-Type-Options", "nosniff")
        .set("Content-Type", "audio/wav")
        .set("Content-Length", String(audio.length))
        .send(audio);
    } catch (error) {
      if (tooLarge) {
        sendError(res, 413, "Audio request exceeds the 84 MB limit.");
      } else if (controller.signal.aborted) {
        sendError(res, 504, "Modal conversion timed out or the request was stopped.");
      } else {
        console.warn(
          `[AccentLab] Modal proxy failure (${error instanceof Error ? error.name : "unknown"})`
        );
        sendError(res, 502, "Modal could not complete this conversion. No automatic retry was sent.");
      }
    } finally {
      clearTimeout(timer);
      req.off("aborted", abortOnDisconnect);
    }
  });
}

export const __modalApiTest = {
  MODAL_STATE_COOKIE,
  MODAL_SESSION_COOKIE,
  MODAL_CALLBACK_PATH,
  normalizeModalEndpoint,
  open,
  seal,
};
