import { describe, expect, it } from "vitest";
import {
  ColabProgressResponseError,
  progressFailureMessage,
  progressHttpDiagnostic,
  readProgressResponse,
} from "../client/src/lib/colab-progress";

describe("managed progress diagnostics", () => {
  it.each([200, 502])(
    "reports safe HTTP/content type for HTML HTTP %s",
    async status => {
      const response = new Response(
        "<html>PRIVATE_PROXY_TOKEN_and_URL</html>",
        {
          status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
      await expect(readProgressResponse(response)).rejects.toThrow(
        `HTTP ${status} (text/html)`
      );
      await expect(readProgressResponse(response)).rejects.not.toThrow(
        "PRIVATE_PROXY_TOKEN"
      );
    }
  );

  it("reports safe diagnostics when claimed JSON is malformed", async () => {
    const response = new Response("PRIVATE_TOKEN invalid json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(readProgressResponse(response)).rejects.toThrow(
      "HTTP 200 (application/json)"
    );
  });

  it.each(["null", "[]", "42", '"private value"'])(
    "rejects non-object JSON without echoing it: %s",
    async value => {
      const response = new Response(value, {
        headers: { "Content-Type": "application/json" },
      });
      await expect(readProgressResponse(response)).rejects.toThrow(
        "HTTP 200 (application/json)"
      );
    }
  );

  it("accepts object JSON and structured JSON content types", async () => {
    const value = {
      stage: "installing",
      message: "Installing pinned dependencies.",
    };
    const response = new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/problem+json; charset=utf-8" },
    });
    await expect(readProgressResponse(response)).resolves.toEqual(value);
  });

  it("does not echo arbitrary MIME values", () => {
    const response = new Response("", {
      status: 502,
      headers: { "Content-Type": "secret/private-token-value" },
    });
    expect(progressHttpDiagnostic(response)).toContain("other content type");
    expect(progressHttpDiagnostic(response)).not.toContain(
      "private-token-value"
    );
  });

  it("reports only safe categories for arbitrary browser exceptions", () => {
    const failure = new TypeError(
      "Failed https://private.gradio.live/?token=PRIVATE"
    );
    expect(progressFailureMessage(failure)).toContain("network error");
    expect(progressFailureMessage(failure)).not.toContain("PRIVATE");
    expect(progressFailureMessage(failure)).not.toContain("gradio.live");
    expect(progressFailureMessage(new Error("PRIVATE"))).not.toContain(
      "PRIVATE"
    );
    expect(
      progressFailureMessage(new DOMException("PRIVATE", "AbortError"))
    ).toContain("timed out");
  });

  it("preserves only explicitly constructed safe progress diagnostics", () => {
    const failure = new ColabProgressResponseError(
      "Progress request returned HTTP 502 (text/html)."
    );
    expect(progressFailureMessage(failure)).toBe(failure.message);
  });
});
