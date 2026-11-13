import { Client, handle_file } from "@gradio/client";
import {
  analyzeExpressionScript,
  MAX_VOCALIZATION_CUES,
} from "./expression-cues";

export const AUDIO_ACCEPT = ".wav,.mp3,.m4a,.ogg,.webm,.aac,.flac";
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_SCRIPT_LENGTH = 1200;
export const REQUIRED_PIPELINE_VERSION =
  "identity-anchored-v5-expressive-text-safe";
const CONNECT_TIMEOUT_MS = 45_000;
const GENERATE_TIMEOUT_MS = 15 * 60_000;

export interface ColabStatus {
  ready: boolean;
  gpu: boolean;
  sample_rate: number;
  message: string;
  pipeline_version: string;
}

export interface GenerationProgress {
  message: string;
  fraction?: number;
}

export interface GenerationInput {
  sourceVoice: File;
  accentReference: File;
  script: string;
  consent: boolean;
  laughSample?: File | null;
  sobSample?: File | null;
}

export function normalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      "Paste the complete HTTPS gradio.live URL printed by Colab."
    );
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.gradio\.live$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Use the temporary https://…gradio.live address, without extra paths, credentials, or parameters."
    );
  }
  return url.origin;
}

export function validateAudio(file: Pick<File, "name" | "size">): void {
  if (!/\.(wav|mp3|m4a|ogg|webm|aac|flac)$/i.test(file.name)) {
    throw new Error(
      "Choose a WAV, MP3, M4A, OGG, WebM, AAC, or FLAC audio file."
    );
  }
  if (!file.size)
    throw new Error("This recording is empty. Choose another audio file.");
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error(
      "Each audio file must be 20 MB or smaller. Use a clean, short recording."
    );
  }
}

export function safeError(error: unknown, accessKey = ""): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The Colab request failed.";
  const redacted = accessKey
    ? raw.split(accessKey).join("[session code]")
    : raw;
  if (
    /failed to fetch|networkerror|network request|load failed|404|502|503|cors|failed to connect|unable to connect|cannot connect|connection (?:error|refused|reset|timed out|failed)|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
      redacted
    )
  ) {
    return "The Colab session is unreachable or has expired. Keep Colab running, then reconnect using its current URL and session code.";
  }
  return redacted.slice(0, 350);
}

export function safeGenerationError(error: unknown, accessKey = ""): string {
  return `${safeError(error, accessKey)} Partial takes are not saved; a new attempt starts from the beginning.`;
}

export function resultAudioUrl(value: unknown, endpoint: string): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new Error(
      "The model did not return an audio file. Check the last Colab cell for an error."
    );
  }
  const url = new URL(value.url, endpoint);
  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(endpoint).origin ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The model returned an unexpected audio location. No file was downloaded."
    );
  }
  return url.href;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireIdentityPipeline(value: unknown): asserts value is ColabStatus {
  if (
    !value ||
    typeof value !== "object" ||
    !("pipeline_version" in value) ||
    value.pipeline_version !== REQUIRED_PIPELINE_VERSION
  ) {
    throw new Error(
      "This Colab worker uses an older conversion pipeline. For manual connection, run the updated v5 notebook; for managed connection, start or reuse the current v5 backend. Then reconnect. No audio was uploaded."
    );
  }
  if (
    !("ready" in value) ||
    !("gpu" in value) ||
    value.ready !== true ||
    value.gpu !== true
  ) {
    throw new Error(
      "The identity-anchored model is not ready. Check Colab and reconnect before generating."
    );
  }
}

export class ColabConnection {
  private closed = false;
  private constructor(
    private readonly client: Client,
    readonly endpoint: string,
    private readonly accessKey: string,
    readonly status: ColabStatus
  ) {}

  static async connect(
    rawEndpoint: string,
    rawKey: string
  ): Promise<ColabConnection> {
    const endpoint = normalizeEndpoint(rawEndpoint);
    const accessKey = rawKey.trim();
    if (!accessKey)
      throw new Error(
        "Paste the session access code printed by the final Colab cell."
      );
    let client: Client | undefined;
    let abandoned = false;
    const pending = Client.connect(endpoint, {
      events: ["status", "data"],
      record_history: false,
    });
    void pending.then(
      lateClient => {
        if (abandoned) lateClient.close();
      },
      () => undefined
    );
    try {
      client = await withTimeout(
        pending,
        CONNECT_TIMEOUT_MS,
        "Colab did not respond in time. Check that the last notebook cell is still running."
      );
      const api = await withTimeout(
        client.view_api(),
        CONNECT_TIMEOUT_MS,
        "Could not read the Colab API. Restart the notebook and reconnect."
      );
      if (
        !api.named_endpoints?.["/status"] ||
        !api.named_endpoints?.["/generate"]
      ) {
        throw new Error(
          "This is an older or different notebook. Run the updated AccentLab notebook with /status and /generate endpoints."
        );
      }
      const response = await withTimeout(
        client.predict("/status", [accessKey]),
        CONNECT_TIMEOUT_MS,
        "The GPU readiness check timed out. Check Colab and reconnect."
      );
      const value = Array.isArray(response.data) ? response.data[0] : undefined;
      if (
        !value ||
        typeof value !== "object" ||
        !("ready" in value) ||
        !("gpu" in value)
      ) {
        throw new Error(
          "Colab returned an incompatible status response. Run the updated notebook."
        );
      }
      const status = value as ColabStatus;
      if (status.ready !== true || status.gpu !== true) {
        throw new Error(
          status.message ||
            "A GPU is not ready. Select T4 GPU in Colab and run all cells."
        );
      }
      if (!Number.isFinite(status.sample_rate) || status.sample_rate < 8000) {
        throw new Error(
          "The notebook returned an invalid sample rate. Run the updated notebook."
        );
      }
      requireIdentityPipeline(status);
      return new ColabConnection(client, endpoint, accessKey, status);
    } catch (error) {
      abandoned = true;
      client?.close();
      throw new Error(safeError(error, accessKey));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
  }

  async generate(
    input: GenerationInput,
    onProgress: (progress: GenerationProgress) => void,
    signal?: AbortSignal
  ): Promise<Blob> {
    if (this.closed)
      throw new Error("The Colab connection has been closed. Reconnect first.");
    validateAudio(input.sourceVoice);
    validateAudio(input.accentReference);
    const script = input.script.trim();
    if (!script || script.length > MAX_SCRIPT_LENGTH)
      throw new Error("Write between 1 and 1,200 characters.");
    if (!input.consent)
      throw new Error(
        "Confirm that you have permission from both speakers before generating."
      );
    const expression = analyzeExpressionScript(
      script,
      Boolean(input.laughSample),
      Boolean(input.sobSample)
    );
    if (expression.missingSamples.length)
      throw new Error(
        `Add the original speaker’s ${expression.missingSamples.join(" and ")} sample before generating.`
      );
    if (!expression.hasSpeech && !expression.hasRenderableVocalization)
      throw new Error(
        "Write spoken words, or provide an original-speaker sample for a vocalization-only take."
      );
    if (expression.tooManyVocalizations)
      throw new Error(
        `Use no more than ${MAX_VOCALIZATION_CUES} laugh, giggle, or sob cues per take.`
      );
    if (expression.hasLaughCue && input.laughSample)
      validateAudio(input.laughSample);
    if (expression.needsSobSample && input.sobSample)
      validateAudio(input.sobSample);
    if (signal?.aborted)
      throw new Error(
        "Stopped listening. A job already running on Colab may still finish."
      );

    // Do not let a runtime that was replaced after connection silently use the
    // old pipeline. This readiness check sends only the session code, not audio.
    onProgress({
      message: "Checking the expressive text-safe model before upload…",
    });
    try {
      const response = await withTimeout(
        this.client.predict("/status", [this.accessKey]),
        CONNECT_TIMEOUT_MS,
        "The model readiness check timed out. Check Colab and reconnect."
      );
      requireIdentityPipeline(
        Array.isArray(response.data) ? response.data[0] : undefined
      );
    } catch (error) {
      throw new Error(safeError(error, this.accessKey));
    }
    if (this.closed || signal?.aborted) {
      throw new Error(
        "Stopped before reference upload. Reconnect before generating."
      );
    }

    const downloadController = new AbortController();
    onProgress({ message: "Uploading references to your Colab session…" });
    const job = this.client.submit("/generate", [
      handle_file(input.sourceVoice),
      handle_file(input.accentReference),
      script,
      this.accessKey,
      true,
      expression.hasLaughCue && input.laughSample
        ? handle_file(input.laughSample)
        : null,
      expression.needsSobSample && input.sobSample
        ? handle_file(input.sobSample)
        : null,
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop: (error: Error) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const stop = (message: string) => {
      try {
        job.cancel();
      } catch {
        /* The remote session may already have stopped. */
      }
      downloadController.abort();
      rejectStop(new Error(message));
    };
    const onAbort = () =>
      stop(
        "Stopped listening. A job already running on Colab may still finish."
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        stop(
          "Conversion exceeded 15 minutes. The free GPU may be busy. Check Colab before trying again."
        ),
      GENERATE_TIMEOUT_MS
    );

    try {
      const work = async () => {
        let audio: unknown;
        for await (const event of job) {
          if (event.type === "status") {
            if (event.stage === "error" || event.success === false) {
              const message =
                typeof event.message === "string"
                  ? event.message
                  : event.message?.map(item => item.message).join(" ");
              throw new Error(
                message ||
                  "The GPU conversion failed. Check the notebook output."
              );
            }
            const progress = event.progress_data?.at(-1);
            const fraction =
              typeof progress?.progress === "number"
                ? Math.max(0, Math.min(1, progress.progress))
                : undefined;
            const message =
              progress?.desc ||
              (event.stage === "pending"
                ? typeof event.position === "number"
                  ? `Queued on Colab · position ${event.position + 1}`
                  : "Waiting for the free GPU…"
                : "Converting the reference voice and accent…");
            onProgress({
              message: safeError(message, this.accessKey),
              fraction,
            });
          }
          if (event.type === "data" && Array.isArray(event.data))
            audio = event.data[0];
        }
        const audioUrl = resultAudioUrl(audio, this.endpoint);
        onProgress({ message: "Downloading the converted WAV…", fraction: 1 });
        const response = await withTimeout(
          fetch(audioUrl, {
            signal: downloadController.signal,
            credentials: "omit",
            cache: "no-store",
          }),
          45_000,
          "The audio download timed out. Check the Colab session."
        );
        if (!response.ok)
          throw new Error(
            "The output download failed. The Colab session may have expired."
          );
        const blob = await withTimeout(
          response.blob(),
          45_000,
          "The audio download timed out."
        );
        if (
          !blob.size ||
          blob.size > 100 * 1024 * 1024 ||
          /text\/|application\/(json|xhtml)/i.test(blob.type)
        ) {
          throw new Error("Colab returned an empty or invalid audio download.");
        }
        const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        const signature = String.fromCharCode(...header);
        if (
          signature.slice(0, 4) !== "RIFF" ||
          signature.slice(8, 12) !== "WAVE"
        ) {
          throw new Error("Colab did not return a valid WAV recording.");
        }
        return new Blob([blob], { type: "audio/wav" });
      };
      return await Promise.race([work(), stopped]);
    } catch (error) {
      try {
        job.cancel();
      } catch {
        /* No remaining active job. */
      }
      downloadController.abort();
      throw new Error(safeError(error, this.accessKey));
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
