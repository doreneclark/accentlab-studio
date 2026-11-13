import {
  createHash,
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { parse as parseCookie } from "cookie";
import type {
  Express,
  Request,
  Response as ExpressResponse,
  NextFunction,
} from "express";
import {
  buildBootstrapResetCode,
  buildBootstrapStartCode,
  buildBootstrapStatusCode,
} from "./colab-bootstrap";
import { HUGGINGFACE_STATE_COOKIE } from "./huggingface-api";

export const COLAB_PUBLIC_ORIGIN = "https://accentlab2-ii4q5q9z.manus.space";
export const COLAB_CALLBACK_PATH = "/api/colab/oauth/callback";
export const COLAB_SCOPE = "https://www.googleapis.com/auth/colaboratory";
export const COLAB_API_ORIGIN = "https://colaboratory.googleapis.com";
export const COLAB_MCP_ORIGIN = "https://colaboratory.googleapis.com/mcp";
export const COLAB_STATE_COOKIE = "accentlab_colab_oauth_state";
export const COLAB_SESSION_COOKIE = "accentlab_colab_session";
export const COLAB_RUNTIME_COOKIE = "accentlab_colab_runtime";
const MAX_HTTP_BODY = 1024 * 1024;
const MAX_JSON_BODY = 16 * 1024;
const STATE_TTL_MS = 10 * 60 * 1000;
const LAUNCH_TTL_MS = 45 * 60 * 1000;
const RUNTIME_IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HTTP_MS = 25_000;
const FREE_TIER = "SUBSCRIPTION_TIER_FREE";
const T4_SPEC = {
  variant: "VARIANT_GPU",
  accelerator: "T4",
  shape: "SHAPE_STANDARD",
} as const;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<globalThis.Response>;
export interface ColabApiOptions {
  clientId?: string;
  clientSecret?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Test seam; production schedules work without awaiting it in the HTTP poll. */
  scheduleBackground?: (task: () => Promise<void>) => Promise<void>;
  /** Explicitly intended for local HTTP tests/development only. */
  allowInsecureCookies?: boolean;
  /** Direct backend contract tests may opt into an absent Origin. */
  allowMissingOrigin?: boolean;
  /** Only the development server may enable the Webdev Preview proxy origin rewrite. */
  allowPreviewProxyOrigin?: boolean;
}

interface RuntimeSpec {
  variant?: unknown;
  accelerator?: unknown;
  shape?: unknown;
  [key: string]: unknown;
}
interface SessionPayload {
  v: 1;
  sid: string;
  runtimeKey: string;
  csrfToken: string;
  accessToken: string;
  exp: number;
}
interface OAuthStatePayload {
  v: 1;
  state: string;
  verifier: string;
  runtimeKey: string;
  exp: number;
}
interface LaunchPayload {
  v: 1;
  sid: string;
  runtimeId: string;
  operationName?: string;
  requestId: string;
  repair: boolean;
  repairPrepared: boolean;
  exp: number;
}
interface ProgressJob {
  sessionId: string;
  runtimeId: string;
  launch: LaunchPayload;
  launchToken: string;
  stage: "installing" | "loading" | "ready" | "error";
  message: string;
  endpoint?: string;
  accessKey?: string;
  operationChecked: boolean;
  workerStarted: boolean;
  running: boolean;
  done: boolean;
  updatedAt: number;
}
interface RuntimeIdentityPayload {
  v: 1;
  runtimeKey: string;
  exp: number;
}
interface RuntimeRecord {
  name?: unknown;
  runtimeId?: unknown;
  id?: unknown;
  state?: unknown;
  runtimeSpec?: RuntimeSpec;
  [key: string]: unknown;
}
function base64url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function fromBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoded value");
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}
function scopedKey(secret: string): Buffer {
  return createHash("sha256")
    .update("accentlab2-colab-cookie-v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}
function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scopedKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `${base64url(iv)}.${base64url(ciphertext)}.${base64url(cipher.getAuthTag())}`;
}
function open<T>(value: string | undefined, secret: string): T | undefined {
  if (!value) return undefined;
  try {
    const parts = value.split(".");
    if (parts.length !== 3) return undefined;
    const iv = fromBase64url(parts[0]);
    const ciphertext = fromBase64url(parts[1]);
    const tag = fromBase64url(parts[2]);
    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      ciphertext.length > MAX_HTTP_BODY
    )
      return undefined;
    const decipher = createDecipheriv("aes-256-gcm", scopedKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as T;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function safeString(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}
function validClientId(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,256}\.apps\.googleusercontent\.com$/.test(value);
}
function validClientSecret(value: string): boolean {
  return /^[^\s]{16,512}$/.test(value);
}
function getQuery(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}
function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000);
}
function jsonHeaders(): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/json" };
}
async function cancelResponseBody(
  response: globalThis.Response
): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* connection may already be closed */
  }
}
async function readResponseTextLimited(
  response: globalThis.Response
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    /^\d+$/.test(declaredLength ?? "") &&
    Number(declaredLength) > MAX_HTTP_BODY
  ) {
    await cancelResponseBody(response);
    throw new Error("response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_HTTP_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
function fixedMessage(message: string): string {
  return message.replace(/[\r\n]/g, " ").slice(0, 240);
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
function readCookie(req: Request, name: string): string | undefined {
  try {
    return parseCookie(req.headers.cookie ?? "")[name];
  } catch {
    return undefined;
  }
}
function clearCookie(
  res: ExpressResponse,
  name: string,
  allowInsecure: boolean
): void {
  res.clearCookie(name, cookieOptions(allowInsecure));
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
function requestBodyIsSmall(req: Request): boolean {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_JSON_BODY)
      return false;
  }
  return (
    Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") <= MAX_JSON_BODY
  );
}
function exactOrigin(
  req: Request,
  expected: string,
  allowMissing: boolean,
  allowPreviewProxyOrigin: boolean
): boolean {
  const origin = req.headers.origin;
  const forwardedHostHeader = req.headers["x-forwarded-host"];
  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedHost =
    typeof forwardedHostHeader === "string"
      ? forwardedHostHeader.split(",")[0].trim()
      : "";
  const forwardedProto =
    typeof forwardedProtoHeader === "string"
      ? forwardedProtoHeader.split(",")[0].trim().toLowerCase()
      : "";
  let expectedUrl: URL | undefined;
  try {
    expectedUrl = new URL(expected);
  } catch {
    expectedUrl = undefined;
  }
  const previewProxyMatch =
    allowPreviewProxyOrigin &&
    origin === "http://127.0.0.1:3000" &&
    req.headers.host === "127.0.0.1:3000" &&
    forwardedProto === "https" &&
    forwardedHost.length > 0 &&
    expected === `https://${forwardedHost}` &&
    expectedUrl?.protocol === "https:" &&
    expectedUrl.hostname.endsWith(".manus.computer") &&
    expectedUrl.host === forwardedHost;
  return (
    origin === expected ||
    previewProxyMatch ||
    (allowMissing && origin === undefined)
  );
}
function requestOrigin(req: Request): string {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const host =
    (typeof forwardedHost === "string" && forwardedHost.split(",")[0].trim()) ||
    (typeof req.headers.host === "string" && req.headers.host.trim());
  if (!host) return COLAB_PUBLIC_ORIGIN;
  const protocol =
    (typeof forwardedProto === "string" &&
      forwardedProto.split(",")[0].trim()) ||
    (req.protocol === "http" ? "http" : "https");
  return `${protocol}://${host}`;
}
function csrfMatches(req: Request, session: SessionPayload): boolean {
  const csrf = req.headers["x-accentlab-csrf"];
  return (
    typeof csrf === "string" && csrf.length <= 256 && csrf === session.csrfToken
  );
}
function configuredMessage(
  clientId: string,
  clientSecret: string
): string | undefined {
  if (!clientId || !validClientId(clientId)) {
    return "Google OAuth client ID is invalid; use the Web application client, not a temporary Gradio session code.";
  }
  if (!clientSecret || !validClientSecret(clientSecret)) {
    return "Google OAuth client secret is missing or invalid.";
  }
  return undefined;
}
function runtimeIdForKey(runtimeKey: string): string {
  return `accentlab-${createHash("sha256").update(`runtime\0${runtimeKey}`).digest("hex").slice(0, 24)}`;
}
function isT4StandardSpec(value: unknown): value is RuntimeSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as RuntimeSpec;
  return (
    spec.variant === T4_SPEC.variant &&
    spec.accelerator === T4_SPEC.accelerator &&
    spec.shape === T4_SPEC.shape
  );
}
function isEligibleT4Spec(value: unknown): value is RuntimeSpec {
  return isT4StandardSpec(value) && (value as RuntimeSpec).eligible === true;
}
function runtimeIdentity(runtime: RuntimeRecord): string | undefined {
  const value = runtime.runtimeId ?? runtime.id ?? runtime.name;
  return typeof value === "string" ? value : undefined;
}
function sameRuntimeId(runtime: RuntimeRecord, runtimeId: string): boolean {
  const id = runtimeIdentity(runtime);
  return (
    id === runtimeId ||
    id === `runtimes/${runtimeId}` ||
    id?.endsWith(`/${runtimeId}`) === true
  );
}
function runtimeReady(runtime: RuntimeRecord | undefined): boolean {
  if (!runtime || !isT4StandardSpec(runtime.runtimeSpec)) return false;
  const connectionInfo = runtime.connectionInfo;
  if (!connectionInfo || typeof connectionInfo !== "object") return false;
  const info = connectionInfo as Record<string, unknown>;
  return (
    typeof info.url === "string" &&
    /^https:\/\//.test(info.url) &&
    typeof info.token === "string" &&
    info.token.length > 0
  );
}
function operationNameOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  return (
    safeString(object.name) ??
    (object.operation && typeof object.operation === "object"
      ? safeString((object.operation as Record<string, unknown>).name)
      : undefined)
  );
}
function listValues(value: unknown): RuntimeRecord[] {
  if (Array.isArray(value))
    return value.filter(
      item => item && typeof item === "object"
    ) as RuntimeRecord[];
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of [
    "runtimes",
    "runtimeSpecs",
    "runtimespecs",
    "specs",
    "items",
  ]) {
    if (Array.isArray(object[key]))
      return object[key].filter(
        item => item && typeof item === "object"
      ) as RuntimeRecord[];
  }
  return [];
}
function extractTier(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  return object.tier ?? object.subscriptionTier ?? object.subscription_tier;
}
function extractSpecs(value: unknown): RuntimeSpec[] {
  if (!value || typeof value !== "object") return [];
  const runtimeSpecs = (value as Record<string, unknown>).runtimeSpecs;
  if (!Array.isArray(runtimeSpecs)) return [];
  return runtimeSpecs.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (!entry.key || typeof entry.key !== "object") return [];
    return [{ ...(entry.key as RuntimeSpec), eligible: entry.eligible }];
  });
}
function errorMessageForStatus(status: number, operation: string): string {
  if (status === 401) return "Google authorization expired; reconnect Colab.";
  if (status === 403)
    return operation === "subscription"
      ? "Google Colab authorization or API access is unavailable."
      : "Google Colab authorization or quota access was denied.";
  if (status === 404)
    return "Google Colab API is unavailable or not enabled for this client.";
  if (status === 429 || status >= 500)
    return "Google Colab is temporarily unavailable or quota-limited. Try again later.";
  return `Google Colab ${operation} request failed.`;
}
class ColabHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly operation: string
  ) {
    super(errorMessageForStatus(status, operation));
  }
}
async function httpJson(
  fetcher: FetchLike,
  input: string,
  init: RequestInit,
  operation: string
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_HTTP_MS);
  try {
    const response = await fetcher(input, {
      ...init,
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response);
      throw new ColabHttpError(response.status, operation);
    }
    const text = await readResponseTextLimited(response);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("invalid response");
    }
  } finally {
    clearTimeout(timer);
  }
}
function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
function mcpJsonResult(raw: string, contentType: string | null): unknown {
  const candidates: string[] = [];
  if (contentType?.includes("text/event-stream")) {
    for (const line of raw.split(/\r?\n/))
      if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
  } else candidates.push(raw);
  let last: unknown;
  for (const candidate of candidates.reverse()) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      last = JSON.parse(candidate) as unknown;
      break;
    } catch {
      /* try the next SSE event */
    }
  }
  return last;
}
function collectJsonTextValues(text: string): unknown[] {
  const candidates = [
    text.trim(),
    ...text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean),
  ];
  const values: unknown[] = [];
  for (const candidate of candidates.slice(-64)) {
    if (candidate.length > MAX_HTTP_BODY) continue;
    try {
      values.push(JSON.parse(candidate) as unknown);
    } catch {
      /* bootstrap progress may be plain text */
    }
  }
  return values;
}
function collectExecutionValues(
  value: unknown,
  output: unknown[] = [],
  seen = new Set<object>(),
  depth = 0
): unknown[] {
  if (value === undefined || value === null) return output;
  if (depth > 12) return output;
  if (typeof value === "string") {
    for (const parsed of collectJsonTextValues(value))
      collectExecutionValues(parsed, output, seen, depth + 1);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      collectExecutionValues(item, output, seen, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return output;
    seen.add(value);
    const object = value as Record<string, unknown>;
    for (const key of [
      "structuredContent",
      "content",
      "result",
      "stdout",
      "stderr",
      "output",
      "data",
      "text",
      "executionError",
      "error",
    ]) {
      collectExecutionValues(object[key], output, seen, depth + 1);
    }
    output.push(value);
  }
  return output;
}
function safeBootstrapMetadata(raw: unknown): {
  stage: "installing" | "loading" | "ready" | "error";
  message: string;
  endpoint?: string;
  accessKey?: string;
} {
  const values = collectExecutionValues(raw);
  for (const value of values.reverse()) {
    if (!value || typeof value !== "object") continue;
    const object = value as Record<string, unknown>;
    if (object.executionError || object.error || object.isError === true)
      return { stage: "error", message: "Colab worker setup failed." };
    const stage = object.stage;
    if (
      stage !== "installing" &&
      stage !== "loading" &&
      stage !== "ready" &&
      stage !== "error"
    )
      continue;
    const endpoint = object.endpoint;
    const accessKey = object.accessKey;
    if (stage === "ready") {
      if (
        typeof endpoint !== "string" ||
        !/^https:\/\/[a-z0-9-]+\.gradio\.live$/.test(endpoint) ||
        typeof accessKey !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(accessKey)
      ) {
        return {
          stage: "error",
          message: "Colab worker returned invalid connection metadata.",
        };
      }
      return { stage, message: "Colab worker is ready.", endpoint, accessKey };
    }
    return {
      stage,
      message:
        stage === "installing"
          ? "Installing the Colab worker."
          : stage === "loading"
            ? "Loading the Colab worker."
            : "Colab worker setup failed.",
    };
  }
  return { stage: "loading", message: "Starting the Colab worker." };
}
async function callMcpTool(
  fetcher: FetchLike,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const response = await fetcher(COLAB_MCP_ORIGIN, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      Accept: "application/json, text/event-stream",
      ...bearer(token),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(MAX_HTTP_MS),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new ColabHttpError(response.status, `MCP ${name}`);
  }
  const text = await readResponseTextLimited(response);
  const result = mcpJsonResult(text, response.headers.get("content-type"));
  if (!result || typeof result !== "object")
    throw new Error("MCP response missing");
  const envelope = result as Record<string, unknown>;
  if (envelope.error && typeof envelope.error === "object") {
    throw new Error(`MCP ${name} failed`);
  }
  return result;
}
function sessionNameFromMcp(
  value: unknown,
  runtimeId: string
): string | undefined {
  const expectedPrefix = `runtimes/${runtimeId}/sessions/`;
  for (const candidate of collectExecutionValues(value).reverse()) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = safeString((candidate as Record<string, unknown>).name, 256);
    if (
      name?.startsWith(expectedPrefix) &&
      /^[a-z0-9-]{1,63}$/.test(name.slice(expectedPrefix.length))
    )
      return name;
  }
  return undefined;
}
async function executeBootstrap(
  fetcher: FetchLike,
  token: string,
  runtimeId: string,
  code: string
): Promise<unknown> {
  const session = await callMcpTool(fetcher, token, "create_session", {
    parent: `runtimes/${runtimeId}`,
    sessionId: "accentlab-bootstrap",
  });
  const sessionName = sessionNameFromMcp(session, runtimeId);
  if (!sessionName) throw new Error("MCP session response missing");
  return callMcpTool(fetcher, token, "execute_code", {
    code,
    session: sessionName,
  });
}
function safeErrorResponse(
  res: ExpressResponse,
  status: number,
  message: string
): void {
  res.status(status).json({ error: fixedMessage(message) });
}

export function registerColabApiRoutes(
  app: Express,
  options: ColabApiOptions = {}
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
  const configurationError = configuredMessage(clientId, clientSecret);
  const fetcher: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const allowInsecureCookies = options.allowInsecureCookies === true;
  const readSession = (req: Request): SessionPayload | undefined => {
    if (configurationError) return undefined;
    const session = open<SessionPayload>(
      readCookie(req, COLAB_SESSION_COOKIE),
      clientSecret
    );
    if (
      !session ||
      session.v !== 1 ||
      !safeString(session.sid, 128) ||
      !safeString(session.runtimeKey, 128) ||
      !safeString(session.csrfToken, 256) ||
      !safeString(session.accessToken, 4096) ||
      !Number.isFinite(session.exp) ||
      session.exp <= nowSeconds(now) + 2
    )
      return undefined;
    return session;
  };
  const authFailure = (res: ExpressResponse, status = 401): void =>
    safeErrorResponse(
      res,
      status,
      "Colab authorization is required; reconnect Colab."
    );
  const privileged: (
    req: Request,
    res: ExpressResponse,
    next: NextFunction
  ) => void | Promise<void> = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const publicOrigin = requestOrigin(req);
    if (
      configurationError ||
      !requestBodyIsSmall(req) ||
      !exactOrigin(
        req,
        publicOrigin,
        options.allowMissingOrigin === true,
        options.allowPreviewProxyOrigin === true
      )
    ) {
      safeErrorResponse(
        res,
        403,
        configurationError
          ? configurationError
          : "Invalid request origin or body."
      );
      return;
    }
    const session = readSession(req);
    if (!session) {
      authFailure(res);
      return;
    }
    if (!csrfMatches(req, session)) {
      safeErrorResponse(res, 403, "Invalid Colab request token.");
      return;
    }
    res.locals.colabSession = session;
    return next();
  };

  const progressJobs = new Map<string, ProgressJob>();
  const launchingRuntimes = new Set<string>();
  const MAX_PROGRESS_JOBS = 64;
  const scheduleBackground =
    options.scheduleBackground ??
    ((task: () => Promise<void>) => Promise.resolve().then(task));
  const pruneProgressJobs = () => {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [runtimeId, job] of progressJobs) {
      // Evict only expired or quiet terminal jobs; stale unprepared repair tokens fail closed below.
      if (
        !job.running &&
        (job.launch.exp <= nowSeconds(now) ||
          (job.done && job.updatedAt < cutoff))
      )
        progressJobs.delete(runtimeId);
    }
  };
  const progressJobBody = (job: ProgressJob) => ({
    launchToken: job.launchToken,
    stage: job.stage,
    message: fixedMessage(job.message),
    ...(job.stage === "ready" && job.endpoint && job.accessKey
      ? { endpoint: job.endpoint, accessKey: job.accessKey }
      : {}),
  });
  const setJobMetadata = (
    job: ProgressJob,
    metadata: ReturnType<typeof safeBootstrapMetadata>
  ) => {
    job.stage = metadata.stage;
    job.message = metadata.message;
    job.endpoint = metadata.endpoint;
    job.accessKey = metadata.accessKey;
    job.done = metadata.stage === "ready" || metadata.stage === "error";
    job.updatedAt = now();
  };
  const advanceProgressJob = async (
    job: ProgressJob,
    session: SessionPayload
  ): Promise<void> => {
    try {
      if (now() >= Math.min(job.launch.exp, session.exp) * 1000) {
        setJobMetadata(job, {
          stage: "error",
          message:
            "Colab setup or authorization expired; reconnect and use safe Start or reuse.",
        });
        return;
      }
      const subscription = await httpJson(
        fetcher,
        `${COLAB_API_ORIGIN}/v1beta/subscription`,
        { headers: bearer(session.accessToken) },
        "subscription"
      );
      if (extractTier(subscription) !== FREE_TIER) {
        setJobMetadata(job, {
          stage: "error",
          message: "Only the Google Colab Free tier is supported.",
        });
        return;
      }
      if (job.launch.operationName && !job.operationChecked) {
        const operationPath = job.launch.operationName.startsWith("operations/")
          ? job.launch.operationName
          : `operations/${job.launch.operationName}`;
        const operation = await httpJson(
          fetcher,
          `${COLAB_API_ORIGIN}/v1/${operationPath}`,
          { headers: bearer(session.accessToken) },
          "runtime operation"
        );
        if (
          operation &&
          typeof operation === "object" &&
          (operation as Record<string, unknown>).error
        ) {
          setJobMetadata(job, {
            stage: "error",
            message: "Free T4 runtime allocation failed.",
          });
          return;
        }
        if (
          !operation ||
          typeof operation !== "object" ||
          (operation as Record<string, unknown>).done !== true
        ) {
          job.stage = "installing";
          job.message = "Allocating a free T4 runtime.";
          job.updatedAt = now();
          return;
        }
        job.operationChecked = true;
        job.launch.operationName = undefined;
        job.launchToken = seal(job.launch, clientSecret);
      }

      const runtime = (await httpJson(
        fetcher,
        `${COLAB_API_ORIGIN}/v1beta/runtimes/${encodeURIComponent(job.runtimeId)}`,
        { headers: bearer(session.accessToken) },
        "runtime status"
      )) as RuntimeRecord;
      if (!isT4StandardSpec(runtime.runtimeSpec)) {
        setJobMetadata(job, {
          stage: "error",
          message:
            "AccentLab requires an eligible standard T4 on the Free tier.",
        });
        return;
      }
      if (!runtimeReady(runtime)) {
        job.stage = "loading";
        job.message = job.launch.repair
          ? "Waiting for the eligible free T4 before repairing AccentLab."
          : "Starting the free T4 runtime.";
        job.updatedAt = now();
        return;
      }

      if (now() >= Math.min(job.launch.exp, session.exp) * 1000 || job.done)
        return;
      if (job.launch.repair && !job.launch.repairPrepared) {
        const reset = safeBootstrapMetadata(
          await executeBootstrap(
            fetcher,
            session.accessToken,
            job.runtimeId,
            buildBootstrapResetCode(job.launch.requestId)
          )
        );
        if (reset.stage === "error") {
          setJobMetadata(job, reset);
          return;
        }
        job.launch.repairPrepared = true;
        job.launchToken = seal(job.launch, clientSecret);
        job.stage = "installing";
        job.message = "Repair confirmed; reinstalling the AccentLab worker.";
        job.updatedAt = now();
      }

      if (now() >= Math.min(job.launch.exp, session.exp) * 1000 || job.done)
        return;
      if (!job.workerStarted) {
        const started = safeBootstrapMetadata(
          await executeBootstrap(
            fetcher,
            session.accessToken,
            job.runtimeId,
            buildBootstrapStartCode(job.launch.requestId)
          )
        );
        job.workerStarted = true;
        setJobMetadata(job, started);
        return;
      }

      setJobMetadata(
        job,
        safeBootstrapMetadata(
          await executeBootstrap(
            fetcher,
            session.accessToken,
            job.runtimeId,
            buildBootstrapStatusCode()
          )
        )
      );
    } catch (error) {
      const failureClass =
        error instanceof ColabHttpError
          ? `http_${error.status}`
          : "provider_request_failed";
      console.warn(`[AccentLab] Colab progress failure (${failureClass})`);
      setJobMetadata(job, {
        stage: "error",
        message:
          error instanceof ColabHttpError
            ? error.message
            : "Unable to read Colab worker progress.",
      });
    }
  };
  const scheduleProgressStep = (job: ProgressJob, session: SessionPayload) => {
    if (job.running || job.done) return;
    job.running = true;
    job.updatedAt = now();
    void scheduleBackground(() => advanceProgressJob(job, session))
      .catch(() => {
        setJobMetadata(job, {
          stage: "error",
          message: "Unable to read Colab worker progress.",
        });
      })
      .finally(() => {
        job.running = false;
        job.updatedAt = now();
      });
  };

  app.get("/api/colab/session", (req: Request, res: ExpressResponse) => {
    res.set("Cache-Control", "no-store");
    if (configurationError) {
      res.json({
        configured: false,
        authorized: false,
        message: configurationError,
      });
      return;
    }
    const session = readSession(req);
    if (!session) {
      const cookie = readCookie(req, COLAB_SESSION_COOKIE);
      if (cookie) clearCookie(res, COLAB_SESSION_COOKIE, allowInsecureCookies);
      res.json({ configured: true, authorized: false });
      return;
    }
    res.json({
      configured: true,
      authorized: true,
      csrfToken: session.csrfToken,
    });
  });

  app.get("/api/colab/oauth/start", (req: Request, res: ExpressResponse) => {
    res.set("Cache-Control", "no-store");
    if (configurationError) {
      res.redirect(302, "/?colab_auth=error");
      return;
    }
    const previousRuntime = open<RuntimeIdentityPayload>(
      readCookie(req, COLAB_RUNTIME_COOKIE),
      clientSecret
    );
    const runtimeKey =
      previousRuntime?.v === 1 &&
      safeString(previousRuntime.runtimeKey, 128) &&
      Number.isFinite(previousRuntime.exp) &&
      previousRuntime.exp > nowSeconds(now)
        ? previousRuntime.runtimeKey
        : base64url(randomBytes(24));
    setCookie(
      res,
      COLAB_RUNTIME_COOKIE,
      seal(
        {
          v: 1,
          runtimeKey,
          exp: nowSeconds(now) + Math.floor(RUNTIME_IDENTITY_TTL_MS / 1000),
        } satisfies RuntimeIdentityPayload,
        clientSecret
      ),
      allowInsecureCookies,
      RUNTIME_IDENTITY_TTL_MS
    );
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const exp = nowSeconds(now) + Math.floor(STATE_TTL_MS / 1000);
    setCookie(
      res,
      COLAB_STATE_COOKIE,
      seal(
        { v: 1, state, verifier, runtimeKey, exp } satisfies OAuthStatePayload,
        clientSecret
      ),
      allowInsecureCookies,
      STATE_TTL_MS
    );
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${requestOrigin(req)}${COLAB_CALLBACK_PATH}`,
      response_type: "code",
      scope: COLAB_SCOPE,
      state,
      access_type: "online",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.redirect(
      302,
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    );
  });

  app.get(
    COLAB_CALLBACK_PATH,
    async (req: Request, res: ExpressResponse, next: NextFunction) => {
      if (readCookie(req, HUGGINGFACE_STATE_COOKIE)) {
        next();
        return;
      }
      res.set("Cache-Control", "no-store");
      const stateCookie = readCookie(req, COLAB_STATE_COOKIE);
      clearCookie(res, COLAB_STATE_COOKIE, allowInsecureCookies);
      if (configurationError) {
        res.redirect(302, "/?colab_auth=error");
        return;
      }
      const statePayload = open<OAuthStatePayload>(stateCookie, clientSecret);
      const state = getQuery(req, "state");
      const code = getQuery(req, "code");
      if (
        !statePayload ||
        statePayload.v !== 1 ||
        statePayload.exp <= nowSeconds(now) ||
        !safeString(statePayload.runtimeKey, 128) ||
        !state ||
        state !== statePayload.state ||
        !code ||
        code.length > 4096
      ) {
        res.redirect(302, "/?colab_auth=error");
        return;
      }
      try {
        const callbackUrl = `${requestOrigin(req)}${COLAB_CALLBACK_PATH}`;
        const token = await httpJson(
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
              redirect_uri: callbackUrl,
              grant_type: "authorization_code",
              code_verifier: statePayload.verifier,
            }).toString(),
          },
          "OAuth token"
        );
        const accessToken =
          token && typeof token === "object"
            ? safeString((token as Record<string, unknown>).access_token, 4096)
            : undefined;
        const expiresIn =
          token &&
          typeof token === "object" &&
          typeof (token as Record<string, unknown>).expires_in === "number"
            ? ((token as Record<string, unknown>).expires_in as number)
            : 0;
        if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 30)
          throw new Error("invalid token");
        const sid = base64url(randomBytes(24));
        const csrfToken = base64url(randomBytes(24));
        const exp = nowSeconds(now) + Math.max(30, Math.floor(expiresIn) - 30);
        const maxAge = Math.max(1000, (exp - nowSeconds(now)) * 1000);
        setCookie(
          res,
          COLAB_SESSION_COOKIE,
          seal(
            {
              v: 1,
              sid,
              runtimeKey: statePayload.runtimeKey,
              csrfToken,
              accessToken,
              exp,
            } satisfies SessionPayload,
            clientSecret
          ),
          allowInsecureCookies,
          maxAge
        );
        res.redirect(302, "/?colab_auth=success");
      } catch (error) {
        if (error instanceof ColabHttpError && error.status === 401) {
          /* do not expose provider response */
        }
        res.redirect(302, "/?colab_auth=error");
      }
    }
  );

  app.post(
    "/api/colab/launch",
    privileged,
    async (req: Request, res: ExpressResponse) => {
      const session = res.locals.colabSession as SessionPayload;
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const repair = body.repair === true;
      if (
        (body.repair !== undefined && typeof body.repair !== "boolean") ||
        (repair && body.confirmation !== "REPAIR_ACCENTLAB") ||
        (!repair && body.confirmation !== undefined)
      ) {
        safeErrorResponse(res, 400, "Invalid Colab launch action.");
        return;
      }
      pruneProgressJobs();
      const runtimeId = runtimeIdForKey(session.runtimeKey);
      const activeJob = progressJobs.get(runtimeId);
      if (activeJob && (!activeJob.done || activeJob.running)) {
        if (repair) {
          safeErrorResponse(
            res,
            409,
            "Another AccentLab setup is already active. Wait for it to finish or use the manual notebook; do not repeat repair."
          );
          return;
        }
        // Safe reauthorization may resume the same job, but never starts or repeats repair.
        if (activeJob.sessionId !== session.sid) {
          activeJob.sessionId = session.sid;
          activeJob.launch.sid = session.sid;
          activeJob.launchToken = seal(activeJob.launch, clientSecret);
        }
        res.json(progressJobBody(activeJob));
        return;
      }
      if (launchingRuntimes.has(runtimeId)) {
        safeErrorResponse(
          res,
          409,
          "AccentLab setup is already being requested; wait before trying again."
        );
        return;
      }
      if (
        progressJobs.size + launchingRuntimes.size >= MAX_PROGRESS_JOBS &&
        !activeJob
      ) {
        safeErrorResponse(
          res,
          503,
          "AccentLab setup is busy; try safe Start or reuse later or use the manual notebook."
        );
        return;
      }
      launchingRuntimes.add(runtimeId);
      try {
        const subscription = await httpJson(
          fetcher,
          `${COLAB_API_ORIGIN}/v1beta/subscription`,
          { headers: bearer(session.accessToken) },
          "subscription"
        );
        if (extractTier(subscription) !== FREE_TIER) {
          safeErrorResponse(
            res,
            409,
            "Only the Google Colab Free tier is supported."
          );
          return;
        }
        const specsResponse = await httpJson(
          fetcher,
          `${COLAB_API_ORIGIN}/v1beta/runtimespecs`,
          { headers: bearer(session.accessToken) },
          "runtime specifications"
        );
        if (!extractSpecs(specsResponse).some(isEligibleT4Spec)) {
          safeErrorResponse(
            res,
            409,
            "An eligible free T4 runtime is unavailable."
          );
          return;
        }
        const listed = await httpJson(
          fetcher,
          `${COLAB_API_ORIGIN}/v1beta/runtimes`,
          { headers: bearer(session.accessToken) },
          "runtime list"
        );
        const own = listValues(listed).find(runtime =>
          sameRuntimeId(runtime, runtimeId)
        );
        if (own && !isT4StandardSpec(own.runtimeSpec)) {
          safeErrorResponse(
            res,
            409,
            "An unrelated runtime already uses the AccentLab runtime name."
          );
          return;
        }
        let operationName: string | undefined;
        const requestId = randomUUID();
        if (!own) {
          const created = await httpJson(
            fetcher,
            `${COLAB_API_ORIGIN}/v1beta/runtimes?requestId=${encodeURIComponent(requestId)}&runtimeId=${encodeURIComponent(runtimeId)}`,
            {
              method: "POST",
              headers: { ...jsonHeaders(), ...bearer(session.accessToken) },
              body: JSON.stringify({
                name: `runtimes/${runtimeId}`,
                runtimeSpec: T4_SPEC,
              }),
            },
            "runtime creation"
          );
          if (
            created &&
            typeof created === "object" &&
            (created as Record<string, unknown>).error
          ) {
            const error = (created as Record<string, unknown>).error;
            const code =
              error && typeof error === "object"
                ? (error as Record<string, unknown>).code
                : undefined;
            if (code !== 6 && code !== "6" && code !== "ALREADY_EXISTS") {
              safeErrorResponse(res, 502, "Free T4 runtime allocation failed.");
              return;
            }
          }
          operationName = operationNameOf(created);
          if (
            created &&
            typeof created === "object" &&
            (created as Record<string, unknown>).error
          )
            operationName = undefined;
        }
        const launch: LaunchPayload = {
          v: 1,
          sid: session.sid,
          runtimeId,
          operationName,
          requestId,
          repair,
          repairPrepared: false,
          exp: nowSeconds(now) + Math.floor(LAUNCH_TTL_MS / 1000),
        };
        const job: ProgressJob = {
          sessionId: session.sid,
          runtimeId,
          launch,
          launchToken: seal(launch, clientSecret),
          stage: own || !operationName ? "loading" : "installing",
          message: repair
            ? own
              ? "Repair confirmed; preparing the existing free T4 runtime."
              : "Allocating an eligible free T4 for the confirmed repair."
            : own
              ? "Using the existing free T4 runtime."
              : "Allocating a free T4 runtime.",
          operationChecked: !operationName,
          workerStarted: false,
          running: false,
          done: false,
          updatedAt: now(),
        };
        progressJobs.set(runtimeId, job);
        res.json(progressJobBody(job));
      } catch (error) {
        const message =
          error instanceof ColabHttpError
            ? error.message
            : "Unable to start the free Colab runtime.";
        safeErrorResponse(
          res,
          error instanceof ColabHttpError && error.status === 401 ? 401 : 502,
          message
        );
      } finally {
        launchingRuntimes.delete(runtimeId);
      }
    }
  );

  app.post(
    "/api/colab/progress",
    privileged,
    async (req: Request, res: ExpressResponse) => {
      const session = res.locals.colabSession as SessionPayload;
      const launchTokenValue =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body.launchToken
          : undefined;
      const launch = open<LaunchPayload>(
        typeof launchTokenValue === "string" ? launchTokenValue : undefined,
        clientSecret
      );
      if (
        !launch ||
        launch.v !== 1 ||
        launch.sid !== session.sid ||
        launch.exp <= nowSeconds(now) ||
        launch.runtimeId !== runtimeIdForKey(session.runtimeKey) ||
        !/^[a-z0-9-]{10,64}$/.test(launch.runtimeId) ||
        !safeString(launch.requestId, 128) ||
        typeof launch.repair !== "boolean" ||
        typeof launch.repairPrepared !== "boolean" ||
        (launch.repairPrepared && !launch.repair)
      ) {
        safeErrorResponse(res, 400, "Invalid or expired Colab launch.");
        return;
      }
      pruneProgressJobs();
      let job = progressJobs.get(launch.runtimeId);
      if (!job && launch.repair && !launch.repairPrepared) {
        safeErrorResponse(
          res,
          409,
          "AccentLab lost temporary setup state after a server restart. The confirmed repair will not be replayed. Use safe Start or reuse, or the manual notebook."
        );
        return;
      }
      if (
        job &&
        (job.sessionId !== session.sid ||
          job.launch.requestId !== launch.requestId ||
          job.launch.repair !== launch.repair)
      ) {
        safeErrorResponse(
          res,
          409,
          "Another AccentLab setup is already running for this runtime. Wait for it to finish before starting another action."
        );
        return;
      }
      if (!job) {
        if (progressJobs.size >= MAX_PROGRESS_JOBS) {
          safeErrorResponse(
            res,
            503,
            "AccentLab setup is busy; try safe Start or reuse later or use the manual notebook."
          );
          return;
        }
        // The signed launch token supports safe status rehydration on another ephemeral instance.
        job = {
          sessionId: session.sid,
          runtimeId: launch.runtimeId,
          launch,
          launchToken: launchTokenValue as string,
          stage: launch.operationName ? "installing" : "loading",
          message: launch.operationName
            ? "Allocating a free T4 runtime."
            : "Reconnecting to the free T4 runtime.",
          operationChecked: !launch.operationName,
          workerStarted: false,
          running: false,
          done: false,
          updatedAt: now(),
        };
        progressJobs.set(launch.runtimeId, job);
      }
      // Cached metadata is authoritative; old encrypted tokens cannot roll it back.
      if (!job.done) scheduleProgressStep(job, session);
      res.json(progressJobBody(job));
    }
  );

  app.post(
    "/api/colab/disconnect",
    privileged,
    (_req: Request, res: ExpressResponse) => {
      clearCookie(res, COLAB_SESSION_COOKIE, allowInsecureCookies);
      // Keep the non-secret browser runtime identity so re-authorization reuses the same T4.
      res.set("Cache-Control", "no-store").json({ disconnected: true });
    }
  );
}

export const __colabTest = {
  seal,
  open,
  runtimeIdForKey,
  isT4StandardSpec,
  executeBootstrap,
  safeBootstrapMetadata,
  readResponseTextLimited,
  COLAB_PUBLIC_ORIGIN,
  COLAB_CALLBACK_PATH,
  COLAB_RUNTIME_COOKIE,
};
