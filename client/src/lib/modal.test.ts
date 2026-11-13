import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWithModal } from "./modal";

function wavFile(name: string) {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "audio/wav" });
}
function minimalWav() {
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return new Blob([bytes], { type: "audio/wav" });
}
function input(script = "Hello there.") {
  return {
    sourceVoice: wavFile("source.wav"),
    accentReference: wavFile("accent.wav"),
    script,
    consent: true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Modal client generation", () => {
  it("sends one same-origin CSRF-protected request and accepts only a WAV result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(minimalWav(), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const result = await generateWithModal(
      input(),
      "owner-csrf-token",
      progress,
      new AbortController().signal
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/modal/generate");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("X-AccentLab-Modal-CSRF")).toBe(
      "owner-csrf-token"
    );
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("sourceVoice")).toBeInstanceOf(File);
    expect(form.get("accentReference")).toBeInstanceOf(File);
    expect(form.get("script")).toBe("Hello there.");
    expect(form.get("consent")).toBe("true");
    expect(result.type).toBe("audio/wav");
    expect(progress).toHaveBeenCalled();
  });

  it("rejects invalid input locally without contacting Modal", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateWithModal(
        { ...input("   ") },
        "owner-csrf-token",
        vi.fn(),
        new AbortController().signal
      )
    ).rejects.toThrow("Enter a script");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-WAV responses and does not retry the paid request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not audio", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateWithModal(
        input(),
        "owner-csrf-token",
        vi.fn(),
        new AbortController().signal
      )
    ).rejects.toThrow("unexpected file type");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
