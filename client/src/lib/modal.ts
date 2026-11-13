import {
  MAX_SCRIPT_LENGTH,
  validateAudio,
  type GenerationInput,
  type GenerationProgress,
} from "./colab";
import { analyzeExpressionScript } from "./expression-cues";

const MAX_GENERATION_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export async function generateWithModal(
  input: GenerationInput,
  csrfToken: string,
  onProgress: (progress: GenerationProgress) => void,
  signal: AbortSignal
): Promise<Blob> {
  validateAudio(input.sourceVoice);
  validateAudio(input.accentReference);
  if (input.laughSample) validateAudio(input.laughSample);
  if (input.sobSample) validateAudio(input.sobSample);
  if (input.script.length > MAX_SCRIPT_LENGTH || !input.script.trim()) {
    throw new Error(`Enter a script between 1 and ${MAX_SCRIPT_LENGTH} characters.`);
  }
  if (!input.consent) throw new Error("Confirm permission before generating.");
  const expression = analyzeExpressionScript(
    input.script,
    Boolean(input.laughSample),
    Boolean(input.sobSample)
  );
  if (expression.tooManyVocalizations) {
    throw new Error("Use no more than six laugh, giggle, or sob cues in one take.");
  }
  if (expression.missingSamples.length > 0) {
    throw new Error(
      `Add the original speaker’s ${expression.missingSamples.join(" and ")} sample before generating.`
    );
  }
  if (!expression.hasSpeech && !expression.hasRenderableVocalization) {
    throw new Error("Enter speech or a vocal cue with its required sample.");
  }

  const form = new FormData();
  form.append("sourceVoice", input.sourceVoice, input.sourceVoice.name);
  form.append("accentReference", input.accentReference, input.accentReference.name);
  form.append("script", input.script);
  form.append("consent", String(input.consent));
  if (expression.hasLaughCue && input.laughSample) {
    form.append("laughSample", input.laughSample, input.laughSample.name);
  }
  if (expression.needsSobSample && input.sobSample) {
    form.append("sobSample", input.sobSample, input.sobSample.name);
  }

  const requestController = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => requestController.abort();
  signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, MAX_GENERATION_MS);

  onProgress({
    message:
      "Sending this owner-authorized request. Modal may cold-start the T4 before conversion; no automatic retry is sent.",
  });
  try {
    const response = await fetch("/api/modal/generate", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "X-AccentLab-Modal-CSRF": csrfToken },
      body: form,
      signal: requestController.signal,
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "Modal could not complete this conversion.";
      throw new Error(message.slice(0, 240));
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/^audio\/(?:wav|wave|x-wav)(?:\s*;|$)/i.test(contentType)) {
      throw new Error("Modal returned an unexpected file type. No audio was saved.");
    }
    const blob = await response.blob();
    if (!blob.size || blob.size > MAX_OUTPUT_BYTES) {
      throw new Error("Modal returned an empty or oversized audio file.");
    }
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (
      header.length < 12 ||
      String.fromCharCode(...header.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...header.slice(8, 12)) !== "WAVE"
    ) {
      throw new Error("Modal did not return a valid WAV recording.");
    }
    onProgress({ message: "WAV ready." });
    return new Blob([blob], { type: "audio/wav" });
  } catch (error) {
    if (timedOut) {
      throw new Error(
        "Modal exceeded the 20-minute request window. The remote job may still be finishing; do not retry until it has ended."
      );
    }
    if (signal.aborted) {
      throw new Error(
        "Stopped waiting for Modal. The remote job may still be finishing; do not retry until it has ended."
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}
