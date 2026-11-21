import { File } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ColabConnection,
  MAX_AUDIO_BYTES,
  REQUIRED_PIPELINE_VERSION,
  normalizeEndpoint,
  resultAudioUrl,
  safeError,
  validateAudio,
} from "./colab";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  handleFile: vi.fn((file: unknown) => ({ upload: file })),
}));

vi.mock("@gradio/client", () => ({
  Client: { connect: mocks.connect },
  handle_file: mocks.handleFile,
}));

const endpoint = "https://session.gradio.live";
const accessKey = "private-session-code";
const status = {
  ready: true,
  gpu: true,
  sample_rate: 22050,
  message: "GPU ready",
  pipeline_version: REQUIRED_PIPELINE_VERSION,
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    view_api: vi.fn().mockResolvedValue({
      named_endpoints: { "/status": {}, "/generate": {} },
    }),
    predict: vi.fn().mockResolvedValue({ data: [status] }),
    submit: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function audio(name: string): globalThis.File {
  return new File(["recording"], name) as unknown as globalThis.File;
}

function generationInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceVoice: audio("source.wav"),
    accentReference: audio("accent.mp3"),
    script: "Hello, how are you?",
    consent: true,
    laughSample: null,
    sobSample: null,
    ...overrides,
  };
}

function submission(events: unknown[]) {
  return {
    cancel: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Colab-only URL and audio validation", () => {
  it("normalizes only a clean HTTPS gradio.live origin", () => {
    expect(normalizeEndpoint(` ${endpoint}/ `)).toBe(endpoint);
    for (const unsafe of [
      "http://session.gradio.live",
      "https://evil.example",
      "https://session.gradio.live/path",
      "https://user:pass@session.gradio.live",
      "https://session.gradio.live?token=secret",
      "https://session.gradio.live:8443",
    ]) {
      expect(() => normalizeEndpoint(unsafe)).toThrow();
    }
  });

  it("validates audio size and limits returned audio to the Colab origin", () => {
    expect(() => validateAudio({ name: "sample.M4A", size: 20 })).not.toThrow();
    expect(() =>
      validateAudio({ name: "oversized.wav", size: MAX_AUDIO_BYTES + 1 })
    ).toThrow();
    expect(
      resultAudioUrl({ url: "/gradio_api/file=output.wav" }, endpoint)
    ).toBe(`${endpoint}/gradio_api/file=output.wav`);
    expect(() =>
      resultAudioUrl({ url: "https://evil.example/output.wav" }, endpoint)
    ).toThrow();
  });

  it("redacts the session code from safe connection errors", () => {
    expect(safeError(new Error(`Rejected ${accessKey}`), accessKey)).toContain(
      "[session code]"
    );
    expect(
      safeError(new Error(`Rejected ${accessKey}`), accessKey)
    ).not.toContain(accessKey);
  });
});

describe("Colab Gradio contract", () => {
  it("requires the notebook session code and checks /status and /generate", async () => {
    await expect(ColabConnection.connect(endpoint, "  ")).rejects.toThrow(
      "session access code"
    );
    const client = fakeClient();
    mocks.connect.mockResolvedValueOnce(client);
    const connection = await ColabConnection.connect(
      endpoint,
      ` ${accessKey} `
    );
    expect(client.view_api).toHaveBeenCalledOnce();
    expect(client.predict).toHaveBeenCalledWith("/status", [accessKey]);
    expect(connection.status.pipeline_version).toBe(REQUIRED_PIPELINE_VERSION);
    connection.close();
  });

  it("checks readiness before submitting /generate and preserves optional laugh/required sob inputs", async () => {
    const client = fakeClient();
    const job = submission([
      {
        type: "data",
        data: [{ url: "/gradio_api/file=voice.wav" }],
      },
    ]);
    client.submit.mockReturnValue(job);
    mocks.connect.mockResolvedValueOnce(client);

    const wavHeader = new Uint8Array(12);
    wavHeader.set([82, 73, 70, 70], 0);
    wavHeader.set([87, 65, 86, 69], 8);
    const wav = new Blob([wavHeader], { type: "audio/wav" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wav)));

    const connection = await ColabConnection.connect(endpoint, accessKey);
    const laughSample = audio("laugh.wav");
    const sobSample = audio("sob.wav");
    const progress: Array<{ message: string; fraction?: number }> = [];
    await connection.generate(
      generationInput({
        script: "Hello [laugh] [sob]",
        laughSample,
        sobSample,
      }),
      value => progress.push(value)
    );

    expect(client.predict).toHaveBeenNthCalledWith(2, "/status", [accessKey]);
    expect(client.submit).toHaveBeenCalledOnce();
    const [api, args] = client.submit.mock.calls[0];
    expect(api).toBe("/generate");
    expect(args[2]).toBe("Hello [laugh] [sob]");
    expect(args[3]).toBe(accessKey);
    expect(args[4]).toBe(true);
    expect(args[5]).toEqual({ upload: laughSample });
    expect(args[6]).toEqual({ upload: sobSample });
    expect(progress.some(item => item.message.includes("before upload"))).toBe(
      true
    );
    connection.close();
  });

  it("does not accept a sob cue without its required original-speaker sample", async () => {
    const client = fakeClient();
    mocks.connect.mockResolvedValueOnce(client);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    await expect(
      connection.generate(
        generationInput({ script: "Hello [sob]" }),
        () => undefined
      )
    ).rejects.toThrow("sob sample");
    expect(client.submit).not.toHaveBeenCalled();
    connection.close();
  });
});
