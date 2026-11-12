import { beforeEach, describe, expect, it, vi } from "vitest";
import { File } from "node:buffer";
import {
  ColabConnection,
  MAX_AUDIO_BYTES,
  REQUIRED_PIPELINE_VERSION,
  normalizeEndpoint,
  resultAudioUrl,
  safeError,
  validateAudio,
} from "../client/src/lib/colab";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  handleFile: vi.fn(file => ({ upload: file })),
}));
vi.mock("@gradio/client", () => ({
  Client: { connect: mocks.connect },
  handle_file: mocks.handleFile,
}));
const endpoint = "https://test-session.gradio.live";
const accessKey = "test-session-code-never-real";
const status = {
  ready: true,
  gpu: true,
  sample_rate: 22050,
  message: "GPU ready",
  pipeline_version: REQUIRED_PIPELINE_VERSION,
};
const api = { named_endpoints: { "/status": {}, "/generate": {} } };

function client(overrides: Record<string, unknown> = {}) {
  return {
    view_api: vi.fn().mockResolvedValue(api),
    predict: vi.fn().mockResolvedValue({ data: [status] }),
    submit: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}
function input() {
  return {
    sourceVoice: new File(
      ["source"],
      "source.wav"
    ) as unknown as globalThis.File,
    accentReference: new File(
      ["accent"],
      "accent.mp3"
    ) as unknown as globalThis.File,
    script: "Hello, how are you?",
    consent: true,
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

describe("Colab URL and audio validation", () => {
  it("accepts a clean temporary Gradio origin", () =>
    expect(normalizeEndpoint(` ${endpoint}/ `)).toBe(endpoint));
  it.each([
    "http://test.gradio.live",
    "https://evil.example",
    "https://test.gradio.live/path",
    "https://user:pass@test.gradio.live",
    "https://test.gradio.live?token=abc",
    "https://test.gradio.live.evil.example",
    "https://test.gradio.live:8443",
  ])("rejects unsafe endpoint %s", url =>
    expect(() => normalizeEndpoint(url)).toThrow()
  );
  it("checks format, emptiness, and size", () => {
    expect(() => validateAudio({ name: "sample.M4A", size: 20 })).not.toThrow();
    expect(() => validateAudio({ name: "sample.txt", size: 20 })).toThrow();
    expect(() => validateAudio({ name: "sample.wav", size: 0 })).toThrow();
    expect(() =>
      validateAudio({ name: "sample.wav", size: MAX_AUDIO_BYTES + 1 })
    ).toThrow();
  });
  it("only downloads files from the connected Gradio origin", () => {
    expect(
      resultAudioUrl({ url: "/gradio_api/file=output.wav" }, endpoint)
    ).toBe(`${endpoint}/gradio_api/file=output.wav`);
    expect(() =>
      resultAudioUrl({ url: "https://evil.example/audio.wav" }, endpoint)
    ).toThrow();
    expect(() =>
      resultAudioUrl({ path: "/tmp/voice.wav" }, endpoint)
    ).toThrow();
  });
  it("redacts access codes from backend errors", () =>
    expect(
      safeError(new Error(`Bad code ${accessKey}`), accessKey)
    ).not.toContain(accessKey));
});

describe("Colab connection", () => {
  it("uses named endpoints and verifies the access code without uploading files", async () => {
    const remote = client();
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    expect(mocks.connect).toHaveBeenCalledWith(endpoint, {
      events: ["status", "data"],
      record_history: false,
    });
    expect(remote.predict).toHaveBeenCalledWith("/status", [accessKey]);
    expect(mocks.handleFile).not.toHaveBeenCalled();
    expect(connection.status).toEqual(status);
    connection.close();
    connection.close();
    expect(remote.close).toHaveBeenCalledTimes(1);
  });
  it("rejects the old placeholder notebook", async () => {
    const remote = client({
      view_api: vi
        .fn()
        .mockResolvedValue({ named_endpoints: { "/predict": {} } }),
    });
    mocks.connect.mockResolvedValue(remote);
    await expect(ColabConnection.connect(endpoint, accessKey)).rejects.toThrow(
      "older or different notebook"
    );
    expect(remote.close).toHaveBeenCalled();
  });
  it.each([undefined, "two-stage-v1", "identity-anchored-v1"])(
    "rejects an incompatible pipeline version %s before uploading",
    async pipelineVersion => {
      const remote = client({
        predict: vi.fn().mockResolvedValue({
          data: [{ ...status, pipeline_version: pipelineVersion }],
        }),
      });
      mocks.connect.mockResolvedValue(remote);
      await expect(
        ColabConnection.connect(endpoint, accessKey)
      ).rejects.toThrow("older conversion pipeline");
      expect(remote.close).toHaveBeenCalled();
      expect(mocks.handleFile).not.toHaveBeenCalled();
      expect(remote.submit).not.toHaveBeenCalled();
    }
  );
  it("rejects a missing GPU", async () => {
    const remote = client({
      predict: vi.fn().mockResolvedValue({
        data: [
          { ...status, ready: false, gpu: false, message: "Select T4 GPU" },
        ],
      }),
    });
    mocks.connect.mockResolvedValue(remote);
    await expect(ColabConnection.connect(endpoint, accessKey)).rejects.toThrow(
      "Select T4 GPU"
    );
  });
});

describe("Colab generation", () => {
  it("uploads both files, forwards all five inputs, reports progress, and returns downloaded audio", async () => {
    const job = submission([
      { type: "status", stage: "pending", position: 0 },
      {
        type: "status",
        stage: "generating",
        progress_data: [{ progress: 0.6, desc: "Blending references" }],
      },
      {
        type: "data",
        data: [{ url: `${endpoint}/gradio_api/file=result.wav` }],
      },
    ]);
    const remote = client({ submit: vi.fn().mockReturnValue(job) });
    mocks.connect.mockResolvedValue(remote);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Blob(["RIFF1234WAVEconverted"], { type: "audio/wav" }))
      );
    vi.stubGlobal("fetch", fetchMock);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    const value = input();
    const progress = vi.fn();
    const output = await connection.generate(value, progress);
    expect(remote.submit).toHaveBeenCalledWith("/generate", [
      { upload: value.sourceVoice },
      { upload: value.accentReference },
      value.script,
      accessKey,
      true,
    ]);
    expect(progress).toHaveBeenCalledWith({
      message: "Blending references",
      fraction: 0.6,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${endpoint}/gradio_api/file=result.wav`,
      expect.objectContaining({ credentials: "omit" })
    );
    expect(output.type).toBe("audio/wav");
    expect(output.size).toBeGreaterThan(0);
  });
  it("does not upload without explicit speaker consent", async () => {
    const remote = client();
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    await expect(
      connection.generate({ ...input(), consent: false }, vi.fn())
    ).rejects.toThrow("permission");
    expect(remote.submit).not.toHaveBeenCalled();
  });
  it("rechecks the identity pipeline before each generation and blocks upload when it changes", async () => {
    const remote = client();
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    remote.predict.mockResolvedValueOnce({
      data: [{ ...status, pipeline_version: "two-stage-v1" }],
    });
    await expect(connection.generate(input(), vi.fn())).rejects.toThrow(
      "older conversion pipeline"
    );
    expect(remote.predict).toHaveBeenCalledTimes(2);
    expect(remote.submit).not.toHaveBeenCalled();
    expect(mocks.handleFile).not.toHaveBeenCalled();
  });
  it("blocks upload if the model becomes not ready after connection", async () => {
    const remote = client();
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    remote.predict.mockResolvedValueOnce({
      data: [{ ...status, ready: false }],
    });
    await expect(connection.generate(input(), vi.fn())).rejects.toThrow(
      "not ready"
    );
    expect(remote.submit).not.toHaveBeenCalled();
    expect(mocks.handleFile).not.toHaveBeenCalled();
  });
  it("rejects model failures and does not substitute neutral TTS", async () => {
    const job = submission([
      { type: "status", stage: "error", message: "Model failed" },
    ]);
    const remote = client({ submit: vi.fn().mockReturnValue(job) });
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    await expect(connection.generate(input(), vi.fn())).rejects.toThrow(
      "Model failed"
    );
    expect(job.cancel).toHaveBeenCalled();
  });
  it("stops during readiness preflight without uploading or queueing audio", async () => {
    const remote = client();
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    const controller = new AbortController();
    const pending = connection.generate(input(), vi.fn(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Stopped before reference upload");
    expect(remote.submit).not.toHaveBeenCalled();
    expect(mocks.handleFile).not.toHaveBeenCalled();
  });
  it("cancels listening when the user stops a queued request", async () => {
    const job = {
      cancel: vi.fn(),
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
    };
    const remote = client({ submit: vi.fn().mockReturnValue(job) });
    mocks.connect.mockResolvedValue(remote);
    const connection = await ColabConnection.connect(endpoint, accessKey);
    const controller = new AbortController();
    const pending = connection.generate(input(), vi.fn(), controller.signal);
    await vi.waitFor(() => expect(remote.submit).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow("Stopped listening");
    expect(job.cancel).toHaveBeenCalled();
  });
  it("rejects HTML pretending to be an output audio download", async () => {
    const job = submission([
      {
        type: "data",
        data: [{ url: `${endpoint}/gradio_api/file=result.wav` }],
      },
    ]);
    const remote = client({ submit: vi.fn().mockReturnValue(job) });
    mocks.connect.mockResolvedValue(remote);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Expired</html>", {
          headers: { "Content-Type": "text/html" },
        })
      )
    );
    const connection = await ColabConnection.connect(endpoint, accessKey);
    await expect(connection.generate(input(), vi.fn())).rejects.toThrow(
      "invalid audio"
    );
  });
});
