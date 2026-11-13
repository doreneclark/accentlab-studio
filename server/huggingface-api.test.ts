import { describe, expect, it, vi } from "vitest";
import { parse as parseCookie } from "cookie";
import {
  __huggingFaceTest,
  registerHuggingFaceApiRoutes,
} from "./huggingface-api";
import type { HuggingFaceLeaseLock } from "./db";

type Handler = (
  req: any,
  res: any,
  next?: (error?: unknown) => void
) => unknown;

class FakeApp {
  routes = new Map<string, Handler[]>();
  get(path: string, ...handlers: Handler[]) {
    const key = `GET ${path}`;
    this.routes.set(key, [...(this.routes.get(key) ?? []), ...handlers]);
    return this;
  }
  post(path: string, ...handlers: Handler[]) {
    const key = `POST ${path}`;
    this.routes.set(key, [...(this.routes.get(key) ?? []), ...handlers]);
    return this;
  }
}

class FakeResponse {
  statusCode = 200;
  body: any;
  locals: Record<string, unknown> = {};
  headers = new Map<string, string>();
  cookies: string[] = [];
  set(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(value: unknown) {
    this.body = value;
    return this;
  }
  redirect(code: number, location: string) {
    this.statusCode = code;
    this.headers.set("location", location);
    return this;
  }
  cookie(name: string, value: string, options: Record<string, unknown>) {
    let header = `${name}=${value}; Path=${options.path ?? "/"}; HttpOnly`;
    if (options.maxAge !== undefined)
      header += `; Max-Age=${Math.floor(Number(options.maxAge) / 1000)}`;
    if (options.sameSite)
      header += `; SameSite=${options.sameSite === "none" ? "None" : "Lax"}`;
    if (options.secure) header += "; Secure";
    this.cookies.push(header);
    return this;
  }
  clearCookie(name: string, options: Record<string, unknown>) {
    this.cookies.push(
      `${name}=; Path=${options.path ?? "/"}; Max-Age=0${options.secure ? "; Secure" : ""}; HttpOnly`
    );
    return this;
  }
}

const CLIENT_ID = "12345678.apps.googleusercontent.com";
const CLIENT_SECRET = "a-plausible-test-client-secret";
const HF_TOKEN = "hf_secret_never_in_response";
const OWNER_EMAIL = "owner@example.com";
const SPACE_ID = "owner/accentlab-vc";
const ORIGIN = "https://accentlab.test";

function request(
  path: string,
  init: Partial<{
    method: string;
    headers: Record<string, string>;
    body: unknown;
    query: Record<string, string>;
  }> = {}
) {
  return {
    method: init.method ?? "GET",
    protocol: "https",
    headers: Object.fromEntries(
      Object.entries({
        host: "accentlab.test",
        origin: ORIGIN,
        ...(init.headers ?? {}),
      }).map(([key, value]) => [key.toLowerCase(), value])
    ),
    body: init.body ?? {},
    query: init.query ?? {},
  };
}

async function invoke(
  app: FakeApp,
  method: string,
  path: string,
  req: any,
  res = new FakeResponse()
) {
  const handlers = app.routes.get(`${method} ${path}`);
  if (!handlers) throw new Error(`No route ${method} ${path}`);
  let index = 0;
  const run = async (): Promise<void> => {
    const handler = handlers[index++];
    if (!handler) return;
    let chained: Promise<void> | undefined;
    let advanced = false;
    const next = (error?: unknown): Promise<void> => {
      if (error) return Promise.reject(error);
      if (advanced) return chained ?? Promise.resolve();
      advanced = true;
      chained = run();
      return chained;
    };
    await handler(req, res, next);
    if (chained) await chained;
  };
  await run();
  return res;
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cookieFrom(response: FakeResponse, name: string): string {
  const line = response.cookies.find(value => value.startsWith(`${name}=`));
  if (!line) throw new Error(`missing ${name} cookie`);
  return line.split(";", 1)[0];
}

function withCookie(req: any, cookie: string) {
  return { ...req, headers: { ...req.headers, cookie } };
}

function setup(fetchMock = vi.fn(), overrides: Record<string, unknown> = {}) {
  const app = new FakeApp();
  const leaseLock = memoryLeaseLock();
  registerHuggingFaceApiRoutes(app as any, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    token: HF_TOKEN,
    spaceId: SPACE_ID,
    spaceAccessKey: "space-app-key-not-hf-token",
    allowedEmail: OWNER_EMAIL,
    fetch: fetchMock as any,
    allowInsecureCookies: true,
    leaseLock,
    now: () => Date.now(),
    ...overrides,
  });
  return { app, fetchMock };
}

function memoryLeaseLock(): HuggingFaceLeaseLock {
  type Record = {
    state: "idle" | "active" | "pausing";
    generationId: string;
    expiresAt: number;
  };
  const records = new Map<string, Record>();
  const locks = new Map<string, Promise<void>>();
  return async (email, operation) => {
    const previous = locks.get(email) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    locks.set(
      email,
      previous.then(() => current)
    );
    await previous;
    try {
      let record = records.get(email) ?? {
        state: "idle" as const,
        generationId: "",
        expiresAt: 0,
      };
      return await operation({
        get: () => ({ ...record }),
        save: async next => {
          record = { ...next };
          records.set(email, record);
        },
      });
    } finally {
      release();
    }
  };
}

async function authorize(
  app: FakeApp,
  fetchMock: ReturnType<typeof vi.fn>,
  email = OWNER_EMAIL
) {
  const start = await invoke(
    app,
    "GET",
    "/api/huggingface/oauth/start",
    request("/api/huggingface/oauth/start")
  );
  const authorization = new URL(start.headers.get("location")!);
  const stateCookie = cookieFrom(
    start,
    __huggingFaceTest.HUGGINGFACE_STATE_COOKIE
  );
  expect(authorization.searchParams.get("scope")).toBe("openid email");
  expect(authorization.searchParams.get("redirect_uri")).toBe(
    `${ORIGIN}${__huggingFaceTest.HUGGINGFACE_CALLBACK_PATH}`
  );
  fetchMock
    .mockResolvedValueOnce(
      responseJson({
        access_token: "google-oauth-access-token",
        expires_in: 3600,
      })
    )
    .mockResolvedValueOnce(
      responseJson({ email, email_verified: true, sub: "google-subject" })
    );
  const callback = await invoke(
    app,
    "GET",
    __huggingFaceTest.HUGGINGFACE_CALLBACK_PATH,
    withCookie(
      request(__huggingFaceTest.HUGGINGFACE_CALLBACK_PATH, {
        query: {
          state: authorization.searchParams.get("state")!,
          code: "test-code",
        },
      }),
      stateCookie
    )
  );
  expect(callback.headers.get("location")).toBe("/?hf_auth=success");
  const ownerCookie = cookieFrom(
    callback,
    __huggingFaceTest.HUGGINGFACE_SESSION_COOKIE
  );
  const opened = __huggingFaceTest.open<any>(
    ownerCookie.split("=")[1],
    CLIENT_SECRET
  );
  return { ownerCookie, csrf: opened.csrfToken };
}

function ownerHeaders(ownerCookie: string, csrf: string) {
  return {
    cookie: ownerCookie,
    origin: ORIGIN,
    "x-accentlab-hf-csrf": csrf,
  };
}

describe("Hugging Face owner controls", () => {
  it("uses verified Google identity and never returns the HF token to the browser", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "PAUSED", requested_hardware: "t4-small" })
    );
    const session = await invoke(
      app,
      "GET",
      "/api/huggingface/session",
      withCookie(request("/api/huggingface/session"), ownerCookie)
    );
    expect(session.body).toMatchObject({
      configured: true,
      authorized: true,
      stage: "paused",
      t4Small: true,
      priceUsdPerHour: 0.4,
      spaceUrl: "https://owner-accentlab-vc.hf.space",
      accessKey: "space-app-key-not-hf-token",
    });
    expect(session.body.csrfToken).toBe(csrf);
    expect(JSON.stringify(session.body)).not.toContain(HF_TOKEN);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo"
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer google-oauth-access-token"
    );
  });

  it("does not label a non-T4 Space as eligible", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie } = await authorize(app, fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "PAUSED", requested_hardware: "a10g-small" })
    );
    const session = await invoke(
      app,
      "GET",
      "/api/huggingface/session",
      withCookie(request("/api/huggingface/session"), ownerCookie)
    );
    expect(session.body.stage).toBe("paused");
    expect(session.body.t4Small).toBe(false);
    expect(session.body.hardware).toBe("a10g-small");
  });

  it("withholds Space credentials when the shared safety database is unavailable", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock, {
      leaseLock: async () => {
        throw new Error("database unavailable");
      },
    });
    const { ownerCookie } = await authorize(app, fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "RUNNING_APP", requested_hardware: "t4-small" })
    );
    const session = await invoke(
      app,
      "GET",
      "/api/huggingface/session",
      withCookie(request("/api/huggingface/session"), ownerCookie)
    );
    expect(session.statusCode).toBe(503);
    expect(session.body.spaceUrl).toBeUndefined();
    expect(session.body.accessKey).toBeUndefined();
  });

  it("fails closed when requested and current Space hardware disagree", () => {
    expect(
      __huggingFaceTest.isT4Small({
        requested_hardware: "t4-small",
        hardware: "a10g-small",
      })
    ).toBe(false);
  });

  it("denies an authenticated but non-allowlisted Google account", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie } = await authorize(
      app,
      fetchMock,
      "visitor@gmail.com"
    );
    const session = await invoke(
      app,
      "GET",
      "/api/huggingface/session",
      withCookie(request("/api/huggingface/session"), ownerCookie)
    );
    expect(session.body.authorized).toBe(false);
    expect(session.body.accessKey).toBeUndefined();
    expect(session.body.csrfToken).toBeUndefined();
  });

  it("does not start without owner authentication, matching origin, CSRF, and explicit cost confirmation", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const anonymous = await invoke(
      app,
      "POST",
      "/api/huggingface/start",
      request("/api/huggingface/start", {
        method: "POST",
        headers: { "x-accentlab-hf-csrf": "anything" },
        body: { confirmation: "HF_T4_SMALL_040_PER_HOUR" },
      })
    );
    expect(anonymous.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "PAUSED", requested_hardware: "t4-small" })
    );
    const noConfirm = await invoke(
      app,
      "POST",
      "/api/huggingface/start",
      withCookie(
        request("/api/huggingface/start", {
          method: "POST",
          headers: ownerHeaders(ownerCookie, "wrong-csrf"),
          body: { confirmation: "HF_T4_SMALL_040_PER_HOUR" },
        }),
        ownerCookie
      )
    );
    expect(noConfirm.statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "PAUSED", requested_hardware: "t4-small" })
    );
    const missingPriceConfirm = await invoke(
      app,
      "POST",
      "/api/huggingface/start",
      request("/api/huggingface/start", {
        method: "POST",
        headers: ownerHeaders(ownerCookie, csrf),
        body: {},
      })
    );
    expect(missingPriceConfirm.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).endsWith("/restart"))
    ).toBe(false);
  });

  it("does not start paid compute when the durable safety lock is unavailable", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock, {
      leaseLock: async () => {
        throw new Error("database unavailable");
      },
    });
    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    const result = await invoke(
      app,
      "POST",
      "/api/huggingface/start",
      request("/api/huggingface/start", {
        method: "POST",
        headers: ownerHeaders(ownerCookie, csrf),
        body: { confirmation: "HF_T4_SMALL_040_PER_HOUR" },
      })
    );
    expect(result.statusCode).toBe(503);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).endsWith("/restart"))
    ).toBe(false);
  });

  it("starts only an existing paused T4-small Space through the explicit restart API", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        responseJson({ stage: "PAUSED", requested_hardware: "t4-small" })
      )
      .mockResolvedValueOnce(responseJson({ stage: "RUNNING_BUILDING" }));
    const result = await invoke(
      app,
      "POST",
      "/api/huggingface/start",
      request("/api/huggingface/start", {
        method: "POST",
        headers: ownerHeaders(ownerCookie, csrf),
        body: { confirmation: "HF_T4_SMALL_040_PER_HOUR" },
      })
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.stage).toBe("starting");
    expect(fetchMock.mock.calls.at(-2)?.[0]).toBe(
      `https://huggingface.co/api/spaces/${SPACE_ID}/runtime`
    );
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `https://huggingface.co/api/spaces/${SPACE_ID}/restart`
    );
    expect(fetchMock.mock.calls.at(-1)?.[1].method).toBe("POST");
    expect(fetchMock.mock.calls.at(-1)?.[1].headers.Authorization).toBe(
      `Bearer ${HF_TOKEN}`
    );
    expect(JSON.stringify(result.body)).not.toContain(HF_TOKEN);
  });

  it("fails closed if the target is not T4-small and never requests different hardware", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "PAUSED", requested_hardware: "a10g-small" })
    );
    const result = await invoke(
      app,
      "POST",
      "/api/huggingface/start",
      request("/api/huggingface/start", {
        method: "POST",
        headers: ownerHeaders(ownerCookie, csrf),
        body: { confirmation: "HF_T4_SMALL_040_PER_HOUR" },
      })
    );
    expect(result.statusCode).toBe(409);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).includes("hardware"))
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).endsWith("/restart"))
    ).toBe(false);
  });

  it("refuses to pause during a live generation lease, then uses the supported pause API", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "RUNNING_APP", requested_hardware: "t4-small" })
    );
    const headers = ownerHeaders(ownerCookie, csrf);
    const lease = await invoke(
      app,
      "POST",
      "/api/huggingface/generation/start",
      request("/api/huggingface/generation/start", { method: "POST", headers })
    );
    expect(lease.statusCode).toBe(200);
    const heartbeat = await invoke(
      app,
      "POST",
      "/api/huggingface/generation/heartbeat",
      request("/api/huggingface/generation/heartbeat", {
        method: "POST",
        headers,
        body: { generationId: lease.body.generationId },
      })
    );
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.body.generationActive).toBe(true);
    expect(heartbeat.body.expiresAt).toBeGreaterThanOrEqual(
      lease.body.expiresAt
    );
    const pausedWhileActive = await invoke(
      app,
      "POST",
      "/api/huggingface/pause",
      request("/api/huggingface/pause", { method: "POST", headers })
    );
    expect(pausedWhileActive.statusCode).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(3); // Google identity and ready T4 check only

    await invoke(
      app,
      "POST",
      "/api/huggingface/generation/end",
      request("/api/huggingface/generation/end", {
        method: "POST",
        headers,
        body: { generationId: lease.body.generationId },
      })
    );
    fetchMock
      .mockResolvedValueOnce(
        responseJson({ stage: "RUNNING_APP", requested_hardware: "t4-small" })
      )
      .mockResolvedValueOnce(responseJson({ stage: "PAUSED" }));
    const paused = await invoke(
      app,
      "POST",
      "/api/huggingface/pause",
      request("/api/huggingface/pause", { method: "POST", headers })
    );
    expect(paused.statusCode).toBe(200);
    expect(paused.body.stage).toBe("paused");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `https://huggingface.co/api/spaces/${SPACE_ID}/pause`
    );
    expect(fetchMock.mock.calls.at(-1)?.[1].method).toBe("POST");
    expect(JSON.stringify(paused.body)).not.toContain(HF_TOKEN);
  });

  it("fences new generations while a starting T4-small Space is being paused", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { ownerCookie, csrf } = await authorize(app, fetchMock);
    const headers = ownerHeaders(ownerCookie, csrf);
    let finishPause: ((response: Response) => void) | undefined;
    const pausePending = new Promise<Response>(resolve => {
      finishPause = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(
        responseJson({
          stage: "RUNNING_BUILDING",
          requested_hardware: "t4-small",
        })
      )
      .mockReturnValueOnce(pausePending)
      .mockResolvedValueOnce(
        responseJson({
          stage: "RUNNING_BUILDING",
          requested_hardware: "t4-small",
        })
      );
    const pausePromise = invoke(
      app,
      "POST",
      "/api/huggingface/pause",
      request("/api/huggingface/pause", { method: "POST", headers })
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const generation = await invoke(
      app,
      "POST",
      "/api/huggingface/generation/start",
      request("/api/huggingface/generation/start", { method: "POST", headers })
    );
    expect(generation.statusCode).toBe(409);
    finishPause?.(responseJson({ stage: "PAUSED" }));
    const paused = await pausePromise;
    expect(paused.statusCode).toBe(200);
    expect(paused.body.stage).toBe("paused");
  });

  it("keeps an expired lease blocking until an owner explicitly verifies completion", async () => {
    let nowMs = Date.now();
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock, { now: () => nowMs });
    const firstSession = await authorize(app, fetchMock);
    const headers = ownerHeaders(firstSession.ownerCookie, firstSession.csrf);
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "RUNNING_APP", requested_hardware: "t4-small" })
    );
    const lease = await invoke(
      app,
      "POST",
      "/api/huggingface/generation/start",
      request("/api/huggingface/generation/start", { method: "POST", headers })
    );
    nowMs = lease.body.expiresAt + 1;
    const refreshedSession = await authorize(app, fetchMock);
    const renewedHeaders = ownerHeaders(
      refreshedSession.ownerCookie,
      refreshedSession.csrf
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({ stage: "RUNNING_APP", requested_hardware: "t4-small" })
    );
    const status = await invoke(
      app,
      "GET",
      "/api/huggingface/session",
      withCookie(
        request("/api/huggingface/session"),
        refreshedSession.ownerCookie
      )
    );
    expect(status.body.generationActive).toBe(true);
    expect(status.body.generationLeaseExpired).toBe(true);
    expect(status.body.generationId).toBe(lease.body.generationId);
    const blockedPause = await invoke(
      app,
      "POST",
      "/api/huggingface/pause",
      request("/api/huggingface/pause", {
        method: "POST",
        headers: renewedHeaders,
      })
    );
    expect(blockedPause.statusCode).toBe(409);
    const cleared = await invoke(
      app,
      "POST",
      "/api/huggingface/generation/clear",
      request("/api/huggingface/generation/clear", {
        method: "POST",
        headers: renewedHeaders,
        body: {
          generationId: lease.body.generationId,
          confirmation: "HF_NO_ACTIVE_GENERATION",
        },
      })
    );
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.generationActive).toBe(false);
  });

  it("uses a finite, server-side authorization session and rejects unverified emails", async () => {
    const open = __huggingFaceTest.open;
    const sealed = __huggingFaceTest.seal(
      {
        v: 1,
        csrfToken: "csrf",
        email: OWNER_EMAIL,
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      CLIENT_SECRET
    );
    expect(open<any>(sealed, CLIENT_SECRET)?.email).toBe(OWNER_EMAIL);
    expect(open<any>(sealed, "wrong-secret")).toBeUndefined();
    const cookie = parseCookie(
      `${__huggingFaceTest.HUGGINGFACE_SESSION_COOKIE}=${sealed}`
    );
    expect(cookie[__huggingFaceTest.HUGGINGFACE_SESSION_COOKIE]).toBe(sealed);
  });
});
