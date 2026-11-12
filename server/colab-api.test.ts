import { describe, expect, it, vi } from "vitest";
import { parse as parseCookie } from "cookie";
import {
  COLAB_CALLBACK_PATH,
  COLAB_PUBLIC_ORIGIN,
  COLAB_RUNTIME_COOKIE,
  __colabTest,
  registerColabApiRoutes,
} from "./colab-api";

const clientId = "12345678.apps.googleusercontent.com";
const clientSecret = "a-plausible-test-client-secret";

type Handler = (req: any, res: any, next?: () => Promise<void>) => unknown;
class FakeApp {
  routes = new Map<string, Handler[]>();
  get(path: string, ...handlers: Handler[]) {
    this.routes.set(`GET ${path}`, handlers);
    return this;
  }
  post(path: string, ...handlers: Handler[]) {
    this.routes.set(`POST ${path}`, handlers);
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
    headers: Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ])
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
  const next = async () => {
    const handler = handlers[index++];
    if (handler) await handler(req, res, next);
  };
  await next();
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
  return { ...req, headers: { ...(req.headers ?? {}), cookie } };
}
function setup(
  fetchMock: ReturnType<typeof vi.fn>,
  now = { value: Date.now() },
  options: { allowPreviewProxyOrigin?: boolean } = {}
) {
  const app = new FakeApp();
  const backgroundTasks: Promise<void>[] = [];
  registerColabApiRoutes(app as any, {
    clientId,
    clientSecret,
    fetch: fetchMock as any,
    now: () => now.value,
    allowInsecureCookies: true,
    allowPreviewProxyOrigin: options.allowPreviewProxyOrigin === true,
    scheduleBackground: task => {
      const promise = Promise.resolve().then(task);
      backgroundTasks.push(promise);
      return promise;
    },
  });
  const waitForBackgroundTasks = async () => {
    while (backgroundTasks.length) {
      const batch = backgroundTasks.splice(0);
      await Promise.all(batch);
    }
  };
  return { app, now, waitForBackgroundTasks };
}
async function authorize(
  app: FakeApp,
  fetchMock: ReturnType<typeof vi.fn>,
  runtimeCookie?: string
) {
  const headers: Record<string, string> = runtimeCookie
    ? { cookie: runtimeCookie }
    : {};
  const start = await invoke(
    app,
    "GET",
    "/api/colab/oauth/start",
    request("/api/colab/oauth/start", { headers })
  );
  const location = start.headers.get("location")!;
  const authorization = new URL(location);
  expect(authorization.searchParams.get("scope")).toBe(
    "https://www.googleapis.com/auth/colaboratory"
  );
  expect(authorization.searchParams.get("access_type")).toBe("online");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  const stateCookie = cookieFrom(start, "accentlab_colab_oauth_state");
  const tokenResponse = responseJson({
    access_token: "provider-token-never-returned",
    expires_in: 3600,
  });
  fetchMock.mockResolvedValueOnce(tokenResponse);
  const callback = await invoke(
    app,
    "GET",
    COLAB_CALLBACK_PATH,
    withCookie(
      request(COLAB_CALLBACK_PATH, {
        query: {
          state: authorization.searchParams.get("state")!,
          code: "one-time-code",
        },
      }),
      stateCookie
    )
  );
  expect(callback.statusCode).toBe(302);
  expect(callback.headers.get("location")).toBe("/?colab_auth=success");
  return {
    sessionCookie: cookieFrom(callback, "accentlab_colab_session"),
    runtimeCookie: cookieFrom(start, COLAB_RUNTIME_COOKIE),
  };
}

describe("Colab configuration and OAuth", () => {
  it("stays statically unconfigured for an invalid client ID and explains the Web client requirement", async () => {
    const app = new FakeApp();
    registerColabApiRoutes(app as any, {
      clientId: "temporary-gradio-code",
      clientSecret,
      allowInsecureCookies: true,
    });
    const response = await invoke(
      app,
      "GET",
      "/api/colab/session",
      request("/api/colab/session")
    );
    expect(response.body).toEqual({
      configured: false,
      authorized: false,
      message: expect.stringContaining("Google OAuth client ID is invalid"),
    });
    expect(response.body.message).toContain("Web application client");
  });

  it("uses encrypted one-time state, PKCE S256, fixed callback and no provider token in redirects", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const start = await invoke(
      app,
      "GET",
      "/api/colab/oauth/start",
      request("/api/colab/oauth/start")
    );
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${COLAB_PUBLIC_ORIGIN}${COLAB_CALLBACK_PATH}`
    );
    expect(location.searchParams.get("access_type")).toBe("online");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/
    );
    expect(start.cookies.join(";")).toContain("SameSite=Lax");
    expect(start.cookies.join(";")).not.toContain("Secure");

    const stateCookie = cookieFrom(start, "accentlab_colab_oauth_state");
    const bad = await invoke(
      app,
      "GET",
      COLAB_CALLBACK_PATH,
      withCookie(
        request(COLAB_CALLBACK_PATH, {
          query: { state: "wrong", code: "oauth-code" },
        }),
        stateCookie
      )
    );
    expect(bad.headers.get("location")).toBe("/?colab_auth=error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bad.cookies.join(";")).toContain("accentlab_colab_oauth_state=");
  });

  it("uses the active forwarded site origin for Test OAuth callbacks", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const start = await invoke(
      app,
      "GET",
      "/api/colab/oauth/start",
      request("/api/colab/oauth/start", {
        headers: {
          host: "accentlab-te-3fwt9qb2.manus.space",
          "x-forwarded-host": "accentlab-te-3fwt9qb2.manus.space",
          "x-forwarded-proto": "https",
        },
      })
    );
    const location = new URL(start.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://accentlab-te-3fwt9qb2.manus.space" + COLAB_CALLBACK_PATH
    );
  });

  it("rejects expired OAuth state without exchanging a code", async () => {
    const fetchMock = vi.fn();
    const clock = { value: Date.now() };
    const { app } = setup(fetchMock, clock);
    const start = await invoke(
      app,
      "GET",
      "/api/colab/oauth/start",
      request("/api/colab/oauth/start")
    );
    const location = new URL(start.headers.get("location")!);
    clock.value += 11 * 60 * 1000;
    const callback = await invoke(
      app,
      "GET",
      COLAB_CALLBACK_PATH,
      withCookie(
        request(COLAB_CALLBACK_PATH, {
          query: {
            state: location.searchParams.get("state")!,
            code: "oauth-code",
          },
        }),
        cookieFrom(start, "accentlab_colab_oauth_state")
      )
    );
    expect(callback.headers.get("location")).toBe("/?colab_auth=error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns private no-store session state and never exposes the provider token", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const { sessionCookie } = await authorize(app, fetchMock);
    const response = await invoke(
      app,
      "GET",
      "/api/colab/session",
      withCookie(request("/api/colab/session"), sessionCookie)
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toEqual({
      configured: true,
      authorized: true,
      csrfToken: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain("provider-token");
  });

  it("reuses the same browser runtime identity after OAuth re-authorization", async () => {
    const fetchMock = vi.fn();
    const { app } = setup(fetchMock);
    const first = await authorize(app, fetchMock);
    const second = await authorize(app, fetchMock, first.runtimeCookie);
    const firstSession = __colabTest.open<any>(
      first.sessionCookie.split("=", 2)[1],
      clientSecret
    )!;
    const secondSession = __colabTest.open<any>(
      second.sessionCookie.split("=", 2)[1],
      clientSecret
    )!;

    expect(firstSession.sid).not.toBe(secondSession.sid);
    expect(firstSession.runtimeKey).toBe(secondSession.runtimeKey);
    expect(__colabTest.runtimeIdForKey(firstSession.runtimeKey)).toBe(
      __colabTest.runtimeIdForKey(secondSession.runtimeKey)
    );
  });
});

describe("Colab privileged route guards and allocation", () => {
  async function authorizedSetup(allowPreviewProxyOrigin = false) {
    const fetchMock = vi.fn();
    const { app, now, waitForBackgroundTasks } = setup(fetchMock, undefined, {
      allowPreviewProxyOrigin,
    });
    const { sessionCookie, runtimeCookie } = await authorize(app, fetchMock);
    const sessionResponse = await invoke(
      app,
      "GET",
      "/api/colab/session",
      withCookie(request("/api/colab/session"), sessionCookie)
    );
    return {
      app,
      fetchMock,
      sessionCookie,
      runtimeCookie,
      csrf: sessionResponse.body.csrfToken as string,
      now,
      waitForBackgroundTasks,
    };
  }
  function launchRequest(
    sessionCookie: string,
    csrf: string,
    body: unknown = {}
  ) {
    return withCookie(
      request("/api/colab/launch", {
        method: "POST",
        headers: { origin: COLAB_PUBLIC_ORIGIN, "x-accentlab-csrf": csrf },
        body,
      }),
      sessionCookie
    );
  }

  function progressRequest(
    sessionCookie: string,
    csrf: string,
    launchToken: string
  ) {
    return withCookie(
      request("/api/colab/progress", {
        method: "POST",
        headers: { origin: COLAB_PUBLIC_ORIGIN, "x-accentlab-csrf": csrf },
        body: { launchToken },
      }),
      sessionCookie
    );
  }

  async function registeredLaunch(
    context: Awaited<ReturnType<typeof authorizedSetup>>,
    repair = false
  ) {
    const { app, fetchMock, sessionCookie, csrf } = context;
    const session = __colabTest.open<any>(
      sessionCookie.split("=", 2)[1],
      clientSecret
    )!;
    const runtimeId = __colabTest.runtimeIdForKey(session.runtimeKey);
    const runtimeBody = {
      name: `runtimes/${runtimeId}`,
      runtimeSpec: {
        variant: "VARIANT_GPU",
        accelerator: "T4",
        shape: "SHAPE_STANDARD",
      },
      connectionInfo: {
        url: "https://runtime.example",
        token: "runtime-proxy-token",
      },
    };
    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(
        responseJson({
          runtimeSpecs: [{ key: runtimeBody.runtimeSpec, eligible: true }],
        })
      )
      .mockResolvedValueOnce(responseJson({ runtimes: [runtimeBody] }));
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(
        sessionCookie,
        csrf,
        repair ? { repair: true, confirmation: "REPAIR_ACCENTLAB" } : {}
      )
    );
    expect(response.statusCode).toBe(200);
    return {
      launchToken: response.body.launchToken as string,
      runtimeBody,
      runtimeId,
    };
  }

  it("requires exact Origin and CSRF for privileged POSTs", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    const noOrigin = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      withCookie(
        request("/api/colab/launch", {
          method: "POST",
          headers: { "x-accentlab-csrf": csrf },
        }),
        sessionCookie
      )
    );
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.headers.get("cache-control")).toBe("no-store");
    const badCsrf = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, "wrong")
    );
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1); // token exchange only
  });

  it("accepts only the exact HTTPS Preview proxy rewrite when enabled, still requiring session and CSRF", async () => {
    const { app, fetchMock, sessionCookie } = await authorizedSetup(true);
    const previewHeaders = {
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
      "x-forwarded-host": "8328-preview.us3.manus.computer",
      "x-forwarded-proto": "https",
    };
    const noSession = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      request("/api/colab/launch", {
        method: "POST",
        headers: previewHeaders,
      })
    );
    expect(noSession.statusCode).toBe(401);

    const badCsrf = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      withCookie(
        request("/api/colab/launch", {
          method: "POST",
          headers: { ...previewHeaders, "x-accentlab-csrf": "wrong" },
        }),
        sessionCookie
      )
    );
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.body.error).toBe("Invalid Colab request token.");

    const wrongForwardedProtocol = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      withCookie(
        request("/api/colab/launch", {
          method: "POST",
          headers: {
            ...previewHeaders,
            "x-forwarded-proto": "http",
            "x-accentlab-csrf": "valid-but-not-needed-for-origin-check",
          },
        }),
        sessionCookie
      )
    );
    expect(wrongForwardedProtocol.statusCode).toBe(403);
    expect(wrongForwardedProtocol.body.error).toBe(
      "Invalid request origin or body."
    );

    const wrongForwardedHost = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      withCookie(
        request("/api/colab/launch", {
          method: "POST",
          headers: {
            ...previewHeaders,
            "x-forwarded-host": "attacker.example",
          },
        }),
        sessionCookie
      )
    );
    expect(wrongForwardedHost.statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1); // token exchange only
  });

  it("keeps the Preview proxy-origin exception disabled by default", async () => {
    const { app, sessionCookie, csrf } = await authorizedSetup();
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      withCookie(
        request("/api/colab/launch", {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:3000",
            host: "127.0.0.1:3000",
            "x-forwarded-host": "8328-preview.us3.manus.computer",
            "x-forwarded-proto": "https",
            "x-accentlab-csrf": csrf,
          },
        }),
        sessionCookie
      )
    );
    expect(response.statusCode).toBe(403);
    expect(response.body.error).toBe("Invalid request origin or body.");
  });

  it("rejects a session whose CSRF token has expired", async () => {
    const { app, sessionCookie, csrf, now } = await authorizedSetup();
    now.value += 3601 * 1000;
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    expect(response.statusCode).toBe(401);
    expect(response.body.error).toContain("reconnect");
  });

  it("rejects a paid subscription before checking specs or creating a runtime", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_PRO" })
    );
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toContain("Free tier");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires eligible exact free T4 standard hardware before creation", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_FREE" })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({
        runtimeSpecs: [
          {
            key: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            eligible: false,
          },
          {
            key: {
              variant: "VARIANT_GPU",
              accelerator: "L4",
              shape: "SHAPE_STANDARD",
            },
            eligible: true,
          },
        ],
      })
    );
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toContain("eligible free T4");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses only the deterministic own runtime with the exact T4 spec", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    const runtimeId = __colabTest.runtimeIdForKey(
      __colabTest.open<any>(sessionCookie.split("=", 2)[1], clientSecret)!
        .runtimeKey
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_FREE" })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({
        runtimeSpecs: [
          {
            key: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            eligible: true,
          },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({
        runtimes: [
          {
            name: `runtimes/${runtimeId}`,
            runtimeSpec: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            connectionInfo: {
              url: "https://runtime.example",
              token: "runtime-proxy-token",
            },
          },
        ],
      })
    );
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.stage).toBe("loading");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).includes("POST"))
    ).toBe(false);
  });

  it("creates a runtime with runtimeSpec in the body and runtimeId only in the query", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    const runtimeId = __colabTest.runtimeIdForKey(
      __colabTest.open<any>(sessionCookie.split("=", 2)[1], clientSecret)!
        .runtimeKey
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_FREE" })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({
        runtimeSpecs: [
          {
            key: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            eligible: true,
          },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(responseJson({ runtimes: [] }));
    fetchMock.mockResolvedValueOnce(
      responseJson({ name: "operations/create-runtime" })
    );

    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    expect(response.statusCode).toBe(200);
    const creation = fetchMock.mock.calls[4];
    expect(creation[0]).toContain(`/v1beta/runtimes?requestId=`);
    expect(creation[0]).toContain(
      `&runtimeId=${encodeURIComponent(runtimeId)}`
    );
    const body = JSON.parse(creation[1].body as string);
    expect(body).toEqual({
      name: `runtimes/${runtimeId}`,
      runtimeSpec: {
        variant: "VARIANT_GPU",
        accelerator: "T4",
        shape: "SHAPE_STANDARD",
      },
    });
    expect(body.spec).toBeUndefined();
    expect(body.runtimeId).toBeUndefined();
  });

  it("verifies exact T4 hardware again before any MCP execution", async () => {
    const { app, fetchMock, sessionCookie, csrf, waitForBackgroundTasks } =
      await authorizedSetup();
    const runtimeId = __colabTest.runtimeIdForKey(
      __colabTest.open<any>(sessionCookie.split("=", 2)[1], clientSecret)!
        .runtimeKey
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_FREE" })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({
        runtimeSpecs: [
          {
            key: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            eligible: true,
          },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(responseJson({ runtimes: [] }));
    fetchMock.mockResolvedValueOnce(
      responseJson({ name: "operations/create-runtime" })
    );
    const launch = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    const launchToken = launch.body.launchToken as string;

    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_FREE" })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({ done: true, response: { name: `runtimes/${runtimeId}` } })
    );
    fetchMock.mockResolvedValueOnce(
      responseJson({
        name: `runtimes/${runtimeId}`,
        runtimeSpec: {
          variant: "VARIANT_GPU",
          accelerator: "L4",
          shape: "SHAPE_STANDARD",
        },
        connectionInfo: {
          url: "https://runtime.example",
          token: "runtime-proxy-token",
        },
      })
    );
    const progress = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      withCookie(
        request("/api/colab/progress", {
          method: "POST",
          headers: { origin: COLAB_PUBLIC_ORIGIN, "x-accentlab-csrf": csrf },
          body: { launchToken },
        }),
        sessionCookie
      )
    );
    expect(progress.statusCode).toBe(200);
    await waitForBackgroundTasks();
    const cachedProgress = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      withCookie(
        request("/api/colab/progress", {
          method: "POST",
          headers: { origin: COLAB_PUBLIC_ORIGIN, "x-accentlab-csrf": csrf },
          body: { launchToken },
        }),
        sessionCookie
      )
    );
    expect(cachedProgress.body.stage).toBe("error");
    expect(cachedProgress.body.message).toContain("standard T4");
    expect(
      fetchMock.mock.calls.some(
        call => String(call[0]) === "https://colaboratory.googleapis.com/mcp"
      )
    ).toBe(false);
  });

  it("returns cached progress immediately while a slow provider call is pending and prevents overlapping steps", async () => {
    const context = await authorizedSetup();
    const { app, fetchMock, sessionCookie, csrf, waitForBackgroundTasks } =
      context;
    const { launchToken, runtimeId } = await registeredLaunch(context);
    const callsBeforeProgress = fetchMock.mock.calls.length;
    let releaseSubscription!: (response: Response) => void;
    const pendingSubscription = new Promise<Response>(resolve => {
      releaseSubscription = resolve;
    });
    fetchMock.mockReturnValueOnce(pendingSubscription);
    fetchMock.mockResolvedValueOnce(
      responseJson({
        name: `runtimes/${runtimeId}`,
        runtimeSpec: {
          variant: "VARIANT_GPU",
          accelerator: "T4",
          shape: "SHAPE_STANDARD",
        },
      })
    );
    const progressRequest = () =>
      withCookie(
        request("/api/colab/progress", {
          method: "POST",
          headers: { origin: COLAB_PUBLIC_ORIGIN, "x-accentlab-csrf": csrf },
          body: { launchToken },
        }),
        sessionCookie
      );

    const first = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest()
    );
    const second = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest()
    );
    expect(first.statusCode).toBe(200);
    expect(first.body.stage).toBe("loading");
    expect(second.body.stage).toBe("loading");
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeProgress + 1);

    releaseSubscription(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }));
    await waitForBackgroundTasks();
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).endsWith("/mcp"))
    ).toBe(false);
  });

  it("maps a provider scope/authorization failure without returning provider data", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    fetchMock.mockResolvedValueOnce(
      responseJson(
        {
          error: {
            error: "insufficient_scope",
            error_description: "provider-token",
          },
        },
        403
      )
    );
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf)
    );
    expect(response.statusCode).toBe(502);
    expect(response.body.error).toContain("authorization or API access");
    expect(JSON.stringify(response.body)).not.toContain("provider-token");
  });

  it("refuses to replay a confirmed repair when temporary state is lost after server restart", async () => {
    const context = await authorizedSetup();
    const { launchToken } = await registeredLaunch(context, true);
    const restartedFetch = vi.fn();
    const { app: restartedApp } = setup(restartedFetch, context.now);
    const response = await invoke(
      restartedApp,
      "POST",
      "/api/colab/progress",
      progressRequest(context.sessionCookie, context.csrf, launchToken)
    );
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toContain("repair will not be replayed");
    expect(restartedFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("provider-token");
  });

  it("rehydrates safe start from the signed token after process restart without reset", async () => {
    const context = await authorizedSetup();
    const { launchToken, runtimeBody, runtimeId } =
      await registeredLaunch(context);
    const restartedFetch = vi.fn();
    const restarted = setup(restartedFetch, context.now);
    const mcpSession = () =>
      responseJson({
        result: {
          structuredContent: {
            name: `runtimes/${runtimeId}/sessions/accentlab-bootstrap`,
          },
        },
      });
    const installing = () =>
      responseJson({
        result: {
          structuredContent: {
            stdout: JSON.stringify({ stage: "installing" }),
          },
        },
      });
    restartedFetch
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(responseJson(runtimeBody))
      .mockResolvedValueOnce(mcpSession())
      .mockResolvedValueOnce(installing());
    const response = await invoke(
      restarted.app,
      "POST",
      "/api/colab/progress",
      progressRequest(context.sessionCookie, context.csrf, launchToken)
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.stage).toBe("loading");
    await restarted.waitForBackgroundTasks();
    const executeCode = restartedFetch.mock.calls
      .filter(call => String(call[0]).endsWith("/mcp"))
      .map(call => JSON.parse(call[1].body as string))
      .filter(payload => payload.params?.name === "execute_code")
      .map(payload => payload.params.arguments.code as string);
    expect(executeCode).toHaveLength(1);
    expect(executeCode[0]).toContain("Starting the Colab backend bootstrap");
    expect(executeCode[0]).not.toContain("EXPECTED_MARKER");
  });

  it("rehydrates a repair only after its token records preparation, without replaying reset", async () => {
    const context = await authorizedSetup();
    const { launchToken, runtimeBody, runtimeId } = await registeredLaunch(
      context,
      true
    );
    const preparedPayload = __colabTest.open<any>(launchToken, clientSecret)!;
    preparedPayload.repairPrepared = true;
    const preparedToken = __colabTest.seal(preparedPayload, clientSecret);
    const restartedFetch = vi.fn();
    const restarted = setup(restartedFetch, context.now);
    restartedFetch
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(responseJson(runtimeBody))
      .mockResolvedValueOnce(
        responseJson({
          result: {
            structuredContent: {
              name: `runtimes/${runtimeId}/sessions/accentlab-bootstrap`,
            },
          },
        })
      )
      .mockResolvedValueOnce(
        responseJson({
          result: {
            structuredContent: {
              stdout: JSON.stringify({ stage: "installing" }),
            },
          },
        })
      );
    const response = await invoke(
      restarted.app,
      "POST",
      "/api/colab/progress",
      progressRequest(context.sessionCookie, context.csrf, preparedToken)
    );
    expect(response.statusCode).toBe(200);
    await restarted.waitForBackgroundTasks();
    const executeCode = restartedFetch.mock.calls
      .filter(call => String(call[0]).endsWith("/mcp"))
      .map(call => JSON.parse(call[1].body as string))
      .filter(payload => payload.params?.name === "execute_code")
      .map(payload => payload.params.arguments.code as string);
    expect(executeCode).toHaveLength(1);
    expect(executeCode[0]).toContain("Starting the Colab backend bootstrap");
    expect(executeCode[0]).not.toContain("EXPECTED_MARKER");
  });

  it("rechecks Free tier in the background and preserves terminal failures without self-repair", async () => {
    const context = await authorizedSetup();
    const { launchToken } = await registeredLaunch(context, true);
    const { app, fetchMock, sessionCookie, csrf, waitForBackgroundTasks } =
      context;
    fetchMock.mockResolvedValueOnce(
      responseJson({ tier: "SUBSCRIPTION_TIER_PRO" })
    );
    await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(sessionCookie, csrf, launchToken)
    );
    await waitForBackgroundTasks();
    const calls = fetchMock.mock.calls.length;
    const cached = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(sessionCookie, csrf, launchToken)
    );
    expect(cached.body.stage).toBe("error");
    expect(cached.body.message).toContain("Free tier");
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).endsWith("/mcp"))
    ).toBe(false);
  });

  it("normal start never resets and returns validated connection fields only when ready", async () => {
    const context = await authorizedSetup();
    const { launchToken, runtimeBody, runtimeId } =
      await registeredLaunch(context);
    const { app, fetchMock, sessionCookie, csrf, waitForBackgroundTasks } =
      context;
    const session = () =>
      responseJson({
        result: {
          structuredContent: {
            name: `runtimes/${runtimeId}/sessions/accentlab-bootstrap`,
          },
        },
      });
    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(responseJson(runtimeBody))
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(
        responseJson({
          result: {
            structuredContent: {
              stdout: JSON.stringify({
                stage: "installing",
                endpoint: "https://unready.gradio.live",
                accessKey: "unready-secret",
                message: "provider-token",
              }),
            },
          },
        })
      );
    const first = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(sessionCookie, csrf, launchToken)
    );
    expect(first.body.endpoint).toBeUndefined();
    await waitForBackgroundTasks();
    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(responseJson(runtimeBody))
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(
        responseJson({
          result: {
            structuredContent: {
              stdout: JSON.stringify({
                stage: "ready",
                endpoint: "https://test-ready.gradio.live",
                accessKey: "valid_test_access_key_1234567890",
              }),
            },
          },
        })
      );
    const pending = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(sessionCookie, csrf, launchToken)
    );
    expect(pending.body.stage).toBe("installing");
    expect(pending.body.endpoint).toBeUndefined();
    expect(JSON.stringify(pending.body)).not.toContain("provider-token");
    expect(JSON.stringify(pending.body)).not.toContain("unready-secret");
    await waitForBackgroundTasks();
    const ready = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(sessionCookie, csrf, launchToken)
    );
    expect(ready.body.stage).toBe("ready");
    expect(ready.body.endpoint).toBe("https://test-ready.gradio.live");
    expect(ready.body.accessKey).toBe("valid_test_access_key_1234567890");
    const code = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith("/mcp"))
      .map(call => JSON.parse(call[1].body as string))
      .filter(payload => payload.params?.name === "execute_code")
      .map(payload => payload.params.arguments.code as string);
    expect(code).toHaveLength(2);
    expect(code.every(value => !value.includes("EXPECTED_MARKER"))).toBe(true);
    expect(JSON.stringify(ready.body)).not.toContain("runtime-proxy-token");
  });

  it("safe start reconnects after OAuth reauthorization without repeating an active repair", async () => {
    const context = await authorizedSetup();
    const { launchToken } = await registeredLaunch(context, true);
    const oldSession = __colabTest.open<any>(
      context.sessionCookie.split("=", 2)[1],
      clientSecret
    )!;
    const callsBeforeReauth = context.fetchMock.mock.calls.length;
    const reauthorized = await authorize(
      context.app,
      context.fetchMock,
      context.runtimeCookie
    );
    const sessionResponse = await invoke(
      context.app,
      "GET",
      "/api/colab/session",
      withCookie(request("/api/colab/session"), reauthorized.sessionCookie)
    );
    const newSession = __colabTest.open<any>(
      reauthorized.sessionCookie.split("=", 2)[1],
      clientSecret
    )!;
    expect(newSession.sid).not.toBe(oldSession.sid);
    expect(newSession.runtimeKey).toBe(oldSession.runtimeKey);
    const csrf = sessionResponse.body.csrfToken as string;
    const safe = await invoke(
      context.app,
      "POST",
      "/api/colab/launch",
      launchRequest(reauthorized.sessionCookie, csrf)
    );
    expect(safe.statusCode).toBe(200);
    expect(safe.body.launchToken).not.toBe(launchToken);
    const rebound = __colabTest.open<any>(safe.body.launchToken, clientSecret);
    expect(rebound.sid).toBe(newSession.sid);
    expect(rebound.repair).toBe(true);
    expect(rebound.repairPrepared).toBe(false);
    const duplicateRepair = await invoke(
      context.app,
      "POST",
      "/api/colab/launch",
      launchRequest(reauthorized.sessionCookie, csrf, {
        repair: true,
        confirmation: "REPAIR_ACCENTLAB",
      })
    );
    expect(duplicateRepair.statusCode).toBe(409);
    expect(context.fetchMock).toHaveBeenCalledTimes(callsBeforeReauth + 1);
  });

  it("serializes concurrent launch requests before provider calls", async () => {
    const context = await authorizedSetup();
    let release!: (response: Response) => void;
    context.fetchMock.mockReturnValueOnce(
      new Promise<Response>(resolve => {
        release = resolve;
      })
    );
    const first = invoke(
      context.app,
      "POST",
      "/api/colab/launch",
      launchRequest(context.sessionCookie, context.csrf)
    );
    await Promise.resolve();
    const second = await invoke(
      context.app,
      "POST",
      "/api/colab/launch",
      launchRequest(context.sessionCookie, context.csrf)
    );
    expect(second.statusCode).toBe(409);
    expect(context.fetchMock).toHaveBeenCalledTimes(2);
    release(responseJson({ tier: "SUBSCRIPTION_TIER_PRO" }));
    await first;
  });

  it("rejects repair without the explicit confirmation marker before provider calls", async () => {
    const { app, fetchMock, sessionCookie, csrf } = await authorizedSetup();
    const response = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf, { repair: true })
    );
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toContain("Invalid Colab launch action");
    expect(fetchMock).toHaveBeenCalledTimes(1); // OAuth token exchange only
  });

  it("runs confirmed repair once, then polls the same verified free T4 worker", async () => {
    const { app, fetchMock, sessionCookie, csrf, waitForBackgroundTasks } =
      await authorizedSetup();
    const runtimeId = __colabTest.runtimeIdForKey(
      __colabTest.open<any>(sessionCookie.split("=", 2)[1], clientSecret)!
        .runtimeKey
    );
    const runtimeBody = {
      name: `runtimes/${runtimeId}`,
      runtimeSpec: {
        variant: "VARIANT_GPU",
        accelerator: "T4",
        shape: "SHAPE_STANDARD",
      },
      connectionInfo: {
        url: "https://runtime.example",
        token: "runtime-proxy-token",
      },
    };
    const runtime = () => responseJson(runtimeBody);
    const session = () =>
      responseJson({
        result: {
          structuredContent: {
            name: `runtimes/${runtimeId}/sessions/accentlab-bootstrap`,
          },
        },
      });
    const execution = (stage: string, message: string) =>
      responseJson({
        result: {
          structuredContent: {
            stdout: JSON.stringify({ stage, message }),
          },
        },
      });

    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(
        responseJson({
          runtimeSpecs: [
            {
              key: {
                variant: "VARIANT_GPU",
                accelerator: "T4",
                shape: "SHAPE_STANDARD",
              },
              eligible: true,
            },
          ],
        })
      )
      .mockResolvedValueOnce(responseJson({ runtimes: [runtimeBody] }));

    const launch = await invoke(
      app,
      "POST",
      "/api/colab/launch",
      launchRequest(sessionCookie, csrf, {
        repair: true,
        confirmation: "REPAIR_ACCENTLAB",
      })
    );
    expect(launch.statusCode).toBe(200);
    const initialPayload = __colabTest.open<any>(
      launch.body.launchToken,
      clientSecret
    );
    expect(initialPayload.repair).toBe(true);
    expect(initialPayload.repairPrepared).toBe(false);

    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(execution("loading", "Managed files cleared."))
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(execution("installing", "Starting reinstall."));
    const progressRequest = (token: string) =>
      withCookie(
        request("/api/colab/progress", {
          method: "POST",
          headers: { origin: COLAB_PUBLIC_ORIGIN, "x-accentlab-csrf": csrf },
          body: { launchToken: token },
        }),
        sessionCookie
      );
    const firstProgress = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(launch.body.launchToken)
    );
    expect(firstProgress.statusCode).toBe(200);
    expect(firstProgress.body.stage).toBe("loading");
    await waitForBackgroundTasks();

    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(execution("installing", "Installing."));
    const progress = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(firstProgress.body.launchToken)
    );
    expect(progress.statusCode).toBe(200);
    expect(progress.body.stage).toBe("installing");
    await waitForBackgroundTasks();
    const preparedPayload = __colabTest.open<any>(
      progress.body.launchToken,
      clientSecret
    );
    expect(preparedPayload.repairPrepared).toBe(true);

    const mcpCalls = fetchMock.mock.calls.filter(call =>
      String(call[0]).endsWith("/mcp")
    );
    const executedCode = mcpCalls
      .map(call => JSON.parse(call[1].body as string))
      .filter(payload => payload.params?.name === "execute_code")
      .map(payload => payload.params.arguments.code as string);
    expect(executedCode).toHaveLength(3);
    expect(executedCode[0]).toContain("EXPECTED_MARKER");
    expect(executedCode[1]).toContain("Starting the Colab backend bootstrap");
    expect(
      executedCode.filter(code => code.includes("EXPECTED_MARKER"))
    ).toHaveLength(1);

    fetchMock
      .mockResolvedValueOnce(responseJson({ tier: "SUBSCRIPTION_TIER_FREE" }))
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(
        execution("installing", "Worker still installing.")
      );
    const laterProgress = await invoke(
      app,
      "POST",
      "/api/colab/progress",
      progressRequest(progress.body.launchToken)
    );
    expect(laterProgress.statusCode).toBe(200);
    await waitForBackgroundTasks();
    const laterMcpCalls = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith("/mcp"))
      .slice(mcpCalls.length);
    const laterCode = laterMcpCalls
      .map(call => JSON.parse(call[1].body as string))
      .filter(payload => payload.params?.name === "execute_code")
      .map(payload => payload.params.arguments.code as string);
    expect(laterCode).toHaveLength(1);
    expect(laterCode.every(code => !code.includes("EXPECTED_MARKER"))).toBe(
      true
    );
  });
});

describe("Colab bootstrap response safety", () => {
  it("creates or reuses the official session, then sends execute_code with its returned resource", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseJson({
          result: {
            structuredContent: {
              name: "runtimes/runtime-123/sessions/accentlab-bootstrap",
            },
          },
        })
      )
      .mockResolvedValueOnce(
        responseJson({
          result: {
            structuredContent: { stdout: JSON.stringify({ stage: "loading" }) },
          },
        })
      );
    await __colabTest.executeBootstrap(
      fetchMock as any,
      "provider-token",
      "runtime-123",
      "print('hello')"
    );
    const createBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(createBody.params).toEqual({
      name: "create_session",
      arguments: {
        parent: "runtimes/runtime-123",
        sessionId: "accentlab-bootstrap",
      },
    });
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe(
      "application/json, text/event-stream"
    );
    const executeBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(executeBody.params).toEqual({
      name: "execute_code",
      arguments: {
        code: "print('hello')",
        session: "runtimes/runtime-123/sessions/accentlab-bootstrap",
      },
    });
  });

  it("parses official stdout text and accepts only constrained connection metadata", () => {
    const metadata = __colabTest.safeBootstrapMetadata({
      result: {
        structuredContent: {
          stdout: `progress\n${JSON.stringify({ stage: "ready", message: "ready", endpoint: "https://accent-session-1.gradio.live", accessKey: "Abcdefghijklmnop_123" })}`,
        },
      },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            accessKey: "provider-secret-that-must-not-be-used",
          }),
        },
      ],
    });
    expect(metadata).toEqual({
      stage: "ready",
      message: "Colab worker is ready.",
      endpoint: "https://accent-session-1.gradio.live",
      accessKey: "Abcdefghijklmnop_123",
    });
    const unsafe = __colabTest.safeBootstrapMetadata({
      stage: "ready",
      endpoint: "https://evil.example",
      accessKey: "short",
    });
    expect(unsafe.stage).toBe("error");
    expect(JSON.stringify(unsafe)).not.toContain("evil.example");
    expect(JSON.stringify(unsafe)).not.toContain("short");
  });

  it("fails closed on MCP JSON-RPC errors without exposing provider details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseJson({
        error: { code: -32000, message: "provider-token must not appear" },
      })
    );
    const failure = await __colabTest
      .executeBootstrap(
        fetchMock as any,
        "provider-token",
        "runtime-123",
        "print('hello')"
      )
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("MCP create_session failed");
    expect((failure as Error).message).not.toContain("provider-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels provider response streams as soon as the one-MiB limit is exceeded", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream);
    await expect(__colabTest.readResponseTextLimited(response)).rejects.toThrow(
      "response too large"
    );
    expect(cancelled).toBe(true);
  });
});
