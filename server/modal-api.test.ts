import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  MODAL_CALLBACK_PATH,
  MODAL_SESSION_COOKIE,
  MODAL_STATE_COOKIE,
  registerModalApiRoutes,
} from "./modal-api";
import { registerColabApiRoutes } from "./colab-api";
import { registerHuggingFaceApiRoutes } from "./huggingface-api";

type Handler = (req: any, res: any, next?: () => Promise<void>) => unknown;
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
class FakeResponse extends EventEmitter {
  statusCode = 200;
  body: any;
  writableEnded = false;
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
    this.writableEnded = true;
    return this;
  }
  send(value: unknown) {
    this.body = value;
    this.writableEnded = true;
    return this;
  }
  redirect(code: number, location: string) {
    this.statusCode = code;
    this.headers.set("location", location);
    this.writableEnded = true;
    return this;
  }
  cookie(name: string, value: string, options: Record<string, unknown>) {
    this.cookies.push(
      `${name}=${value}; Path=${options.path ?? "/"}; HttpOnly; SameSite=${options.sameSite === "none" ? "None" : "Lax"}${options.secure ? "; Secure" : ""}`
    );
    return this;
  }
  clearCookie(name: string) {
    this.cookies.push(`${name}=; Max-Age=0`);
    return this;
  }
}
function reqFor(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = ""
) {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as any;
  req.method = method;
  req.url = path;
  req.path = path;
  req.protocol = "https";
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  req.query = {};
  return req;
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
    let nextPromise: Promise<void> | undefined;
    const next = () => (nextPromise ??= run());
    await handler(req, res, next);
    if (nextPromise) await nextPromise;
  };
  await run();
  return res;
}
function responseJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function cookieFrom(res: FakeResponse, name: string) {
  const line = res.cookies.find(value => value.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing ${name} cookie`);
  return line.split(";", 1)[0];
}

const allowedEmail = "topspeedmgt@gmail.com";
const appOrigin = "https://accentlab.test";
const baseOptions = {
  clientId: "12345678.apps.googleusercontent.com",
  clientSecret: "modal-test-oauth-secret",
  allowedEmail,
  endpointUrl: "https://accentlab-studio-v5.modal.run",
  proxyKey: "test-modal-proxy-key",
  proxySecret: "test-modal-proxy-secret",
  allowInsecureCookies: true,
};

describe("Modal API owner controls", () => {
  it("dispatches the shared Google callback through Colab and Hugging Face to Modal", async () => {
    const modalFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token"))
        return responseJson({ access_token: "modal-owner-token", expires_in: 3600 });
      if (String(input).includes("openidconnect.googleapis.com/v1/userinfo"))
        return responseJson({ email: allowedEmail, email_verified: true });
      throw new Error(`Unexpected URL: ${String(input)}`);
    });
    const app = new FakeApp();
    registerColabApiRoutes(app as any, {
      clientId: baseOptions.clientId,
      clientSecret: "colab-test-secret",
      allowInsecureCookies: true,
    });
    registerHuggingFaceApiRoutes(app as any, { allowInsecureCookies: true });
    registerModalApiRoutes(app as any, {
      ...baseOptions,
      fetch: modalFetch as any,
    });

    const start = await invoke(
      app,
      "GET",
      "/api/modal/oauth/start",
      reqFor("GET", "/api/modal/oauth/start", { host: "accentlab.test" })
    );
    const authorization = new URL(start.headers.get("location")!);
    const callbackReq = reqFor("GET", MODAL_CALLBACK_PATH, {
      host: "accentlab.test",
      cookie: cookieFrom(start, MODAL_STATE_COOKIE),
    });
    callbackReq.query = {
      state: authorization.searchParams.get("state"),
      code: "one-time-google-code",
    };
    const callback = await invoke(app, "GET", MODAL_CALLBACK_PATH, callbackReq);
    expect(callback.headers.get("location")).toBe("/?modal_auth=success");
    expect(modalFetch).toHaveBeenCalledTimes(2);
  });

  it("never calls the worker without the verified owner session and CSRF token", async () => {
    const fetchMock = vi.fn();
    const app = new FakeApp();
    registerModalApiRoutes(app as any, { ...baseOptions, fetch: fetchMock as any });
    const body = "--unit-boundary\r\n--unit-boundary--\r\n";
    const response = await invoke(
      app,
      "POST",
      "/api/modal/generate",
      reqFor("POST", "/api/modal/generate", {
        host: "accentlab.test",
        origin: appOrigin,
        "content-type": "multipart/form-data; boundary=unit-boundary",
        "content-length": String(Buffer.byteLength(body)),
      }, body)
    );
    expect(response.statusCode).toBe(401);
    expect(response.body.error).toContain("Authorized Google account");
    expect(fetchMock).not.toHaveBeenCalled();

    const wrongOrigin = await invoke(
      app,
      "POST",
      "/api/modal/generate",
      reqFor("POST", "/api/modal/generate", {
        host: "accentlab.test",
        origin: "https://untrusted.example",
      })
    );
    expect(wrongOrigin.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes only verified allowlisted Google identity and proxies one WAV request with server-held credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token"))
        return responseJson({ access_token: "google-access-token", expires_in: 3600 });
      if (url.includes("openidconnect.googleapis.com/v1/userinfo"))
        return responseJson({ email: allowedEmail, email_verified: true });
      if (url === "https://accentlab-studio-v5.modal.run/generate") {
        expect(new Headers(init?.headers).get("Modal-Key")).toBe(baseOptions.proxyKey);
        expect(new Headers(init?.headers).get("Modal-Secret")).toBe(baseOptions.proxySecret);
        expect(new Headers(init?.headers).get("accept")).toBe("audio/wav");
        const forwarded = await new Response(init?.body as BodyInit).arrayBuffer();
        expect(new TextDecoder().decode(forwarded)).toContain("unit-boundary");
        const wav = Buffer.alloc(44);
        wav.write("RIFF", 0, "ascii");
        wav.writeUInt32LE(36, 4);
        wav.write("WAVE", 8, "ascii");
        wav.write("fmt ", 12, "ascii");
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(16000, 24);
        wav.writeUInt32LE(32000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36, "ascii");
        wav.writeUInt32LE(0, 40);
        return new Response(wav, { headers: { "content-type": "audio/wav" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = new FakeApp();
    registerModalApiRoutes(app as any, { ...baseOptions, fetch: fetchMock as any });

    const start = await invoke(
      app,
      "GET",
      "/api/modal/oauth/start",
      reqFor("GET", "/api/modal/oauth/start", { host: "accentlab.test" })
    );
    const authorization = new URL(start.headers.get("location")!);
    expect(authorization.searchParams.get("scope")).toBe("openid email");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${appOrigin}${MODAL_CALLBACK_PATH}`
    );
    const stateCookie = cookieFrom(start, MODAL_STATE_COOKIE);
    const callbackReq = reqFor(
      "GET",
      MODAL_CALLBACK_PATH,
      { host: "accentlab.test", cookie: stateCookie }
    );
    callbackReq.query = {
      state: authorization.searchParams.get("state"),
      code: "one-time-google-code",
    };
    const callback = await invoke(app, "GET", MODAL_CALLBACK_PATH, callbackReq);
    expect(callback.headers.get("location")).toBe("/?modal_auth=success");
    expect(callback.headers.get("location")).not.toContain("google-access-token");
    const sessionCookie = cookieFrom(callback, MODAL_SESSION_COOKIE);

    const session = await invoke(
      app,
      "GET",
      "/api/modal/session",
      reqFor("GET", "/api/modal/session", { cookie: sessionCookie })
    );
    expect(session.body).toMatchObject({ configured: true, authorized: true });
    expect(typeof session.body.csrfToken).toBe("string");
    const csrfToken = session.body.csrfToken as string;

    const multipart =
      "--unit-boundary\r\nContent-Disposition: form-data; name=\"script\"\r\n\r\nHello\r\n--unit-boundary--\r\n";
    const generation = await invoke(
      app,
      "POST",
      "/api/modal/generate",
      reqFor(
        "POST",
        "/api/modal/generate",
        {
          host: "accentlab.test",
          origin: appOrigin,
          cookie: sessionCookie,
          "x-accentlab-modal-csrf": csrfToken,
          "content-type": "multipart/form-data; boundary=unit-boundary",
          "content-length": String(Buffer.byteLength(multipart)),
        },
        multipart
      )
    );
    expect(generation.statusCode).toBe(200);
    expect(generation.headers.get("content-type")).toBe("audio/wav");
    expect((generation.body as Buffer).subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const unverifiedApp = new FakeApp();
    const unverifiedFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token"))
        return responseJson({ access_token: "other-user-token", expires_in: 3600 });
      return responseJson({ email: allowedEmail, email_verified: false });
    });
    registerModalApiRoutes(unverifiedApp as any, {
      ...baseOptions,
      fetch: unverifiedFetch as any,
    });
    const unverifiedStart = await invoke(
      unverifiedApp,
      "GET",
      "/api/modal/oauth/start",
      reqFor("GET", "/api/modal/oauth/start", { host: "accentlab.test" })
    );
    const unverifiedAuthorization = new URL(unverifiedStart.headers.get("location")!);
    const unverifiedCallbackReq = reqFor(
      "GET",
      MODAL_CALLBACK_PATH,
      {
        host: "accentlab.test",
        cookie: cookieFrom(unverifiedStart, MODAL_STATE_COOKIE),
      }
    );
    unverifiedCallbackReq.query = {
      state: unverifiedAuthorization.searchParams.get("state"),
      code: "one-time-google-code",
    };
    const unverifiedCallback = await invoke(
      unverifiedApp,
      "GET",
      MODAL_CALLBACK_PATH,
      unverifiedCallbackReq
    );
    expect(unverifiedCallback.headers.get("location")).toBe("/?modal_auth=unauthorized");
    expect(unverifiedCallback.cookies.some(cookie => cookie.startsWith(`${MODAL_SESSION_COOKIE}=`))).toBe(false);
  });
});
