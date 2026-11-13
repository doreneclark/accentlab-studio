import {
  ArrowUpRight,
  AudioLines,
  Check,
  CircleAlert,
  Download,
  FileAudio,
  LoaderCircle,
  LockKeyhole,
  Mic2,
  RotateCcw,
  Sparkles,
  UploadCloud,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIO_ACCEPT,
  ColabConnection,
  MAX_SCRIPT_LENGTH,
  safeError,
  safeGenerationError,
  validateAudio,
  type GenerationProgress,
} from "@/lib/colab";
import {
  ColabProgressResponseError,
  progressFailureMessage,
  progressHttpDiagnostic,
  readProgressResponse,
} from "@/lib/colab-progress";
import {
  analyzeExpressionScript,
} from "@/lib/expression-cues";
import { generateWithModal } from "@/lib/modal";

type RecordingKind = "source" | "accent" | "laugh" | "sob";
type Provider = "colab" | "huggingface" | "modal";
type GenerationState = "idle" | "generating" | "complete" | "error";
type ConnectionState = "disconnected" | "connecting" | "connected";
type ManagedStage = "idle" | "installing" | "loading" | "ready" | "error";
type HuggingFaceStage =
  | "paused"
  | "starting"
  | "ready"
  | "generating"
  | "pausing"
  | "error";

interface ColabSessionResponse {
  configured: boolean;
  authorized: boolean;
  csrfToken?: string;
  message?: string;
}

interface HuggingFaceSessionResponse {
  configured: boolean;
  authorized: boolean;
  csrfToken?: string;
  stage?: "paused" | "starting" | "ready" | "error";
  hardware?: string | null;
  t4Small?: boolean;
  generationActive?: boolean;
  generationLeaseExpired?: boolean;
  generationId?: string;
  pausePending?: boolean;
  generationLeaseExpiresAt?: number;
  priceUsdPerHour?: number;
  spaceUrl?: string;
  accessKey?: string;
  message?: string;
  error?: string;
}

interface ModalSessionResponse {
  configured: boolean;
  authorized: boolean;
  csrfToken?: string;
  message?: string;
}

interface ColabLaunchResponse {
  launchToken: string;
  stage: Exclude<ManagedStage, "idle">;
  message: string;
  endpoint?: string;
  accessKey?: string;
}

const COLAB_POLL_INTERVAL_MS = 8_000;
const COLAB_MAX_POLL_MS = 30 * 60 * 1_000;
const HUGGINGFACE_POLL_INTERVAL_MS = 8_000;

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Waveform() {
  const bars = [
    18, 28, 42, 30, 56, 38, 66, 44, 25, 51, 72, 42, 28, 60, 36, 48, 24, 36, 62,
    44, 20, 32, 52, 28, 42, 18, 35, 55, 29, 45, 22, 38,
  ];
  return (
    <div className="waveform" aria-hidden="true">
      {bars.map((height, index) => (
        <span key={index} style={{ height: `${height}%` }} />
      ))}
    </div>
  );
}

function UploadCard({
  kind,
  file,
  disabled,
  onSelect,
  onClear,
}: {
  kind: RecordingKind;
  file: File | null;
  disabled: boolean;
  onSelect: (file?: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const isSource = kind === "source";
  const isAccent = kind === "accent";
  const label = isSource
    ? "Voice identity"
    : isAccent
      ? "Accent reference"
      : kind === "laugh"
        ? "Laugh / giggle sample (optional)"
        : "Cry / sob sample (required for [sob])";
  const uploadTitle = isSource
    ? "Original speaker"
    : isAccent
      ? "Target accent"
      : kind === "laugh"
        ? "Original speaker’s laugh (optional)"
        : "Original speaker’s sob";
  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div
      className={`reference-card compact-card ${kind === "laugh" || kind === "sob" ? "expression-sample-card" : ""} ${file ? "has-file" : ""}`}
    >
      <div className="reference-topline">
        <span className="mini-label">{label}</span>
        <span className="status-badge">
          <span className="status-dot" />
          {file ? "Loaded" : "Waiting"}
        </span>
      </div>
      {!file ? (
        <button
          className="upload-zone compact-zone"
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <span className="upload-icon">
            <UploadCloud size={19} />
          </span>
          <span className="upload-title">{uploadTitle}</span>
          <span className="upload-subtitle">
            {kind === "source" || kind === "accent"
              ? "Clean 5–30 sec excerpt · up to 20 MB"
              : kind === "laugh"
                ? "Optional · no clip means the cue is skipped · up to 20 MB"
                : "Needed for [sob] · clean 1–8 sec sound · up to 20 MB"}
          </span>
        </button>
      ) : (
        <div className="loaded-reference compact-loaded">
          <div className="file-row">
            <span className="file-icon">
              <FileAudio size={16} />
            </span>
            <span className="file-info">
              <strong>{file.name}</strong>
              <small>
                {formatBytes(file.size)} ·{" "}
                {isSource
                  ? "identity source"
                  : isAccent
                    ? "accent guide"
                    : "event sample"}
              </small>
            </span>
            <button
              className="icon-button"
              type="button"
              disabled={disabled}
              onClick={onClear}
              aria-label={`Remove ${label.toLowerCase()}`}
            >
              <X size={15} />
            </button>
          </div>
          <Waveform />
          {previewUrl && (
            <audio
              className="reference-player"
              controls
              preload="metadata"
              src={previewUrl}
              aria-label={`Preview ${label.toLowerCase()}`}
            />
          )}
        </div>
      )}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept={AUDIO_ACCEPT}
        disabled={disabled}
        aria-label={`Upload ${label.toLowerCase()}`}
        onChange={event => {
          onSelect(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

export default function Home() {
  const [provider, setProvider] = useState<Provider>("colab");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [accentFile, setAccentFile] = useState<File | null>(null);
  const [laughSample, setLaughSample] = useState<File | null>(null);
  const [sobSample, setSobSample] = useState<File | null>(null);
  const [script, setScript] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [colabConfigured, setColabConfigured] = useState<boolean | null>(null);
  const [colabAuthorized, setColabAuthorized] = useState(false);
  const [colabSessionLoading, setColabSessionLoading] = useState(true);
  const [colabCsrfToken, setColabCsrfToken] = useState("");
  const [colabSessionMessage, setColabSessionMessage] = useState("");
  const [colabAuthNotice, setColabAuthNotice] = useState("");
  const [colabAuthNoticeIsError, setColabAuthNoticeIsError] = useState(false);
  const [hfConfigured, setHfConfigured] = useState<boolean | null>(null);
  const [hfAuthorized, setHfAuthorized] = useState(false);
  const [hfSessionLoading, setHfSessionLoading] = useState(true);
  const [hfAuthNotice, setHfAuthNotice] = useState("");
  const [hfCsrfToken, setHfCsrfToken] = useState("");
  const [hfStage, setHfStage] = useState<HuggingFaceStage>("paused");
  const [hfRuntimeRunning, setHfRuntimeRunning] = useState(false);
  const [hfHardwareConfirmed, setHfHardwareConfirmed] = useState(false);
  const [hfMessage, setHfMessage] = useState("");
  const [hfPrice, setHfPrice] = useState(0.4);
  const [hfSpaceUrl, setHfSpaceUrl] = useState("");
  const [hfAccessKey, setHfAccessKey] = useState("");
  const [hfGenerationActive, setHfGenerationActive] = useState(false);
  const [hfLeaseExpired, setHfLeaseExpired] = useState(false);
  const [hfLeaseId, setHfLeaseId] = useState("");
  const [modalConfigured, setModalConfigured] = useState<boolean | null>(null);
  const [modalAuthorized, setModalAuthorized] = useState(false);
  const [modalSessionLoading, setModalSessionLoading] = useState(true);
  const [modalCsrfToken, setModalCsrfToken] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalAuthNotice, setModalAuthNotice] = useState("");
  const [managedStage, setManagedStage] = useState<ManagedStage>("idle");
  const [managedMessage, setManagedMessage] = useState("");
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [generationState, setGenerationState] =
    useState<GenerationState>("idle");
  const [progress, setProgress] = useState<GenerationProgress>({ message: "" });
  const [error, setError] = useState("");
  const [outputBlob, setOutputBlob] = useState<Blob | null>(null);
  const [outputUrl, setOutputUrl] = useState("");
  const connectionRef = useRef<ColabConnection | null>(null);
  const generationAbort = useRef<AbortController | null>(null);
  const scriptInput = useRef<HTMLTextAreaElement | null>(null);
  const connectionAttempt = useRef(0);
  const managedPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const managedPollInFlight = useRef(false);
  const managedPollToken = useRef("");
  const managedPollDeadline = useRef(0);
  const managedVerifyAttempt = useRef(0);
  const hfStatusInFlight = useRef(false);
  const hfConnectInFlight = useRef(false);
  const mountedRef = useRef(true);
  const busy = generationState === "generating";
  const hasScript = Boolean(script.trim());
  const expression = useMemo(
    () =>
      analyzeExpressionScript(script, Boolean(laughSample), Boolean(sobSample)),
    [script, laughSample, sobSample]
  );
  const canGenerate = Boolean(
    sourceFile &&
      accentFile &&
      (expression.hasSpeech || expression.hasRenderableVocalization) &&
      expression.missingSamples.length === 0 &&
      !expression.tooManyVocalizations &&
      consent &&
      (provider === "modal"
        ? modalAuthorized && Boolean(modalCsrfToken)
        : connectionState === "connected") &&
      !busy
  );
  const estimatedSeconds = useMemo(
    () =>
      expression.spokenText.trim()
        ? `${Math.max(2, Math.round(expression.spokenText.trim().split(/\s+/).length / 2.35))} sec`
        : "—",
    [expression.spokenText]
  );

  const clearManagedPolling = () => {
    if (managedPollTimer.current) clearTimeout(managedPollTimer.current);
    managedPollTimer.current = null;
    managedPollToken.current = "";
    managedPollDeadline.current = 0;
  };

  useEffect(() => {
    if (!outputBlob) {
      setOutputUrl("");
      return;
    }
    const url = URL.createObjectURL(outputBlob);
    setOutputUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [outputBlob]);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams(window.location.search);
    const authResult = query.get("colab_auth");
    const hfAuthResult = query.get("hf_auth");
    const modalAuthResult = query.get("modal_auth");
    if (authResult) {
      query.delete("colab_auth");
      const nextQuery = query.toString();
      window.history.replaceState(
        window.history.state,
        document.title,
        `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`
      );
      const succeeded = authResult === "success";
      setColabAuthNotice(
        succeeded
          ? "Google authorization completed. You can now start a free T4 runtime."
          : "Google authorization did not complete. You can still use the manual Colab URL and access-code connection below."
      );
      setColabAuthNoticeIsError(!succeeded);
    }
    if (hfAuthResult) {
      query.delete("hf_auth");
      const nextQuery = query.toString();
      window.history.replaceState(
        window.history.state,
        document.title,
        `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`
      );
      setHfAuthNotice(
        hfAuthResult === "success"
          ? "Google identity verified. Hugging Face controls are available only if this is the allowlisted account."
          : "Google identity verification did not complete. Hugging Face controls remain unavailable."
      );
    }
    if (modalAuthResult) {
      query.delete("modal_auth");
      const nextQuery = query.toString();
      window.history.replaceState(
        window.history.state,
        document.title,
        `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`
      );
      setModalAuthNotice(
        modalAuthResult === "success"
          ? "Google identity verified. Modal generation is restricted to the allowlisted owner account."
          : "Google identity verification did not complete. Modal remains unavailable."
      );
    }

    const loadSession = async () => {
      try {
        const response = await fetch("/api/colab/session", {
          credentials: "include",
          cache: "no-store",
        });
        const body = (await response
          .json()
          .catch(() => ({}))) as ColabSessionResponse;
        if (!response.ok)
          throw new Error(
            body.message || "Could not check Colab authorization."
          );
        if (cancelled) return;
        setColabConfigured(body.configured);
        setColabAuthorized(body.authorized);
        setColabCsrfToken(body.csrfToken || "");
        setColabSessionMessage(body.message || "");
      } catch (failure) {
        if (!cancelled) {
          setColabConfigured(null);
          setColabAuthorized(false);
          setColabCsrfToken("");
          setColabSessionMessage(
            failure instanceof Error
              ? failure.message
              : "Could not check Colab authorization. Manual connection is still available."
          );
        }
      } finally {
        if (!cancelled) setColabSessionLoading(false);
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      mountedRef.current = false;
      clearManagedPolling();
      connectionAttempt.current += 1;
      generationAbort.current?.abort();
      connectionRef.current?.close();
    },
    []
  );

  const resetOutput = () => {
    setOutputBlob(null);
    setGenerationState("idle");
    setError("");
    setProgress({ message: "" });
  };
  const disconnect = () => {
    connectionAttempt.current += 1;
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnectionState("disconnected");
    setSampleRate(null);
    setConnectionError("");
  };
  const stopManagedWithError = (message: string) => {
    clearManagedPolling();
    if (!mountedRef.current) return;
    setManagedStage("error");
    setManagedMessage(message);
  };
  const setFile = (kind: RecordingKind, file?: File) => {
    if (!file || busy) return;
    try {
      validateAudio(file);
      if (kind === "source") setSourceFile(file);
      else if (kind === "accent") setAccentFile(file);
      else if (kind === "laugh") setLaughSample(file);
      else setSobSample(file);
      resetOutput();
    } catch (failure) {
      setError(safeError(failure));
      setGenerationState("error");
    }
  };

  const insertExpressionCue = (cue: string) => {
    if (busy) return;
    const textarea = scriptInput.current;
    const start = textarea?.selectionStart ?? script.length;
    const end = textarea?.selectionEnd ?? start;
    const before = script.slice(0, start);
    const after = script.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const insertion = `${prefix}${cue}${suffix}`;
    const nextScript = `${before}${insertion}${after}`;
    if (nextScript.length > MAX_SCRIPT_LENGTH) {
      setError(`Cues and text share the ${MAX_SCRIPT_LENGTH}-character limit.`);
      setGenerationState("error");
      return;
    }
    setScript(nextScript);
    resetOutput();
    requestAnimationFrame(() => {
      if (!textarea) return;
      const position = before.length + insertion.length;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  const connectWithCredentials = async (
    rawEndpoint: string,
    rawAccessKey: string,
    selectedProvider: "Colab" | "Hugging Face" = "Colab"
  ): Promise<boolean> => {
    if (busy) return false;
    disconnect();
    const attempt = ++connectionAttempt.current;
    setConnectionState("connecting");
    setConnectionError("");
    try {
      const connection = await ColabConnection.connect(
        rawEndpoint,
        rawAccessKey,
        selectedProvider
      );
      if (attempt !== connectionAttempt.current) {
        connection.close();
        return false;
      }
      connectionRef.current = connection;
      setEndpoint(connection.endpoint);
      setSampleRate(connection.status.sample_rate);
      setConnectionState("connected");
      return true;
    } catch (failure) {
      if (attempt !== connectionAttempt.current) return false;
      setConnectionState("disconnected");
      setConnectionError(safeError(failure, rawAccessKey, selectedProvider));
      return false;
    }
  };

  const refreshHuggingFaceSession = async (checkInference = false) => {
    if (hfStatusInFlight.current) return;
    hfStatusInFlight.current = true;
    try {
      const response = await fetch("/api/huggingface/session", {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as HuggingFaceSessionResponse;
      if (!response.ok)
        throw new Error(body.error || "Could not check Hugging Face status.");
      setHfAuthNotice("");
      setHfConfigured(body.configured);
      setHfAuthorized(body.authorized);
      setHfCsrfToken(body.csrfToken || "");
      setHfPrice(
        typeof body.priceUsdPerHour === "number" ? body.priceUsdPerHour : 0.4
      );
      setHfGenerationActive(body.generationActive === true);
      setHfLeaseExpired(body.generationLeaseExpired === true);
      setHfLeaseId(body.generationId || "");
      setHfHardwareConfirmed(body.t4Small === true);
      setHfRuntimeRunning(
        (body.stage === "ready" || body.stage === "starting") &&
          body.t4Small === true
      );
      setHfSpaceUrl(body.authorized ? body.spaceUrl || "" : "");
      setHfAccessKey(body.authorized ? body.accessKey || "" : "");
      setHfMessage(
        body.pausePending
          ? "Pause is pending; new generations remain blocked until Hugging Face confirms the Space is paused."
          : body.stage === "ready" && body.t4Small !== true
            ? "Space is running on hardware other than T4-small. AccentLab will not connect, start, change, or pause it; check the Hugging Face Space settings."
            : body.message || ""
      );
      const nextStage: HuggingFaceStage = body.generationActive
        ? "generating"
        : body.pausePending
          ? "pausing"
          : body.stage === "ready" && body.t4Small !== true
            ? "error"
            : body.stage || (body.configured ? "error" : "paused");
      setHfStage(nextStage);
      if (
        checkInference &&
        provider === "huggingface" &&
        body.authorized &&
        body.stage === "ready" &&
        body.t4Small === true &&
        !body.pausePending &&
        !body.generationActive &&
        body.spaceUrl &&
        body.accessKey &&
        connectionState !== "connected" &&
        connectionState !== "connecting" &&
        !busy &&
        !hfConnectInFlight.current
      ) {
        hfConnectInFlight.current = true;
        const connected = await connectWithCredentials(
          body.spaceUrl,
          body.accessKey,
          "Hugging Face"
        );
        if (connected) {
          setHfStage("ready");
          setHfMessage("v5 inference health check passed. T4-small is ready.");
        } else {
          setHfStage("starting");
          setHfMessage(
            "Space is running; waiting for v5 inference to finish loading."
          );
        }
      }
    } catch (failure) {
      setHfRuntimeRunning(false);
      setHfHardwareConfirmed(false);
      setHfLeaseExpired(false);
      setHfLeaseId("");
      setHfStage("error");
      setHfAuthNotice(
        failure instanceof Error
          ? failure.message
          : "Hugging Face controls could not verify their safety state."
      );
      setHfMessage(
        failure instanceof Error
          ? failure.message
          : "Could not check Hugging Face status."
      );
    } finally {
      hfStatusInFlight.current = false;
      hfConnectInFlight.current = false;
      setHfSessionLoading(false);
    }
  };

  const refreshModalSession = async () => {
    setModalSessionLoading(true);
    try {
      const response = await fetch("/api/modal/session", {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as ModalSessionResponse;
      if (!response.ok)
        throw new Error(body.message || "Could not check Modal authorization.");
      setModalConfigured(body.configured);
      setModalAuthorized(body.authorized);
      setModalCsrfToken(body.csrfToken || "");
      setModalMessage(body.message || "");
    } catch (failure) {
      setModalConfigured(null);
      setModalAuthorized(false);
      setModalCsrfToken("");
      setModalMessage(
        failure instanceof Error
          ? failure.message
          : "Could not check Modal authorization."
      );
    } finally {
      setModalSessionLoading(false);
    }
  };

  useEffect(() => {
    void refreshModalSession();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await refreshHuggingFaceSession(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      provider !== "huggingface" ||
      !hfAuthorized ||
      (hfStage !== "starting" &&
        hfStage !== "ready" &&
        hfStage !== "pausing" &&
        !hfGenerationActive)
    )
      return;
    const timer = setInterval(() => {
      void refreshHuggingFaceSession(true);
    }, HUGGINGFACE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [provider, hfAuthorized, hfStage, hfGenerationActive, connectionState]);

  const handleConnect = async () => {
    if (connectionState === "connecting" || busy) return;
    await connectWithCredentials(endpoint, accessKey);
  };

  const verifyManagedConnection = async (
    managedEndpoint: string,
    managedAccessKey: string,
    message: string
  ) => {
    clearManagedPolling();
    const verifyAttempt = ++managedVerifyAttempt.current;
    disconnect();
    setEndpoint(managedEndpoint);
    setAccessKey(managedAccessKey);
    setManagedStage("ready");
    setManagedMessage(`${message} Verifying the Gradio health endpoint…`);
    const connected = await connectWithCredentials(
      managedEndpoint,
      managedAccessKey
    );
    if (!mountedRef.current || verifyAttempt !== managedVerifyAttempt.current)
      return;
    if (connected) {
      setManagedMessage(
        "Free T4 runtime is ready and its Gradio health check passed."
      );
    } else {
      stopManagedWithError(
        "The managed runtime reported ready, but its Gradio health check failed. Keep Colab running or use the manual connection fields."
      );
    }
  };

  const scheduleManagedPoll = (launchToken: string) => {
    if (!mountedRef.current || managedPollToken.current !== launchToken) return;
    if (managedPollTimer.current) clearTimeout(managedPollTimer.current);
    managedPollTimer.current = setTimeout(() => {
      managedPollTimer.current = null;
      void pollManagedRuntime(launchToken);
    }, COLAB_POLL_INTERVAL_MS);
  };

  const pollManagedRuntime = async (launchToken: string) => {
    if (
      !mountedRef.current ||
      managedPollToken.current !== launchToken ||
      managedPollInFlight.current
    )
      return;
    if (Date.now() >= managedPollDeadline.current) {
      stopManagedWithError(
        "Colab did not provide a usable connection within 30 minutes. Safe setup will not stop, delete, or restart a runtime. If an existing runtime is unavailable, start or reconnect it manually in Colab, then use the manual fields; the URL and code fill automatically once a runtime is ready."
      );
      return;
    }
    managedPollInFlight.current = true;
    try {
      const response = await fetch("/api/colab/progress", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-AccentLab-CSRF": colabCsrfToken,
        },
        body: JSON.stringify({ launchToken }),
      });
      const body = (await readProgressResponse(
        response
      )) as Partial<ColabLaunchResponse> & {
        error?: string;
      };
      if (managedPollToken.current !== launchToken) return;
      if (!response.ok) {
        throw new ColabProgressResponseError(
          typeof body.error === "string"
            ? body.error
            : progressHttpDiagnostic(response)
        );
      }
      if (managedPollToken.current !== launchToken) return;
      const nextLaunchToken =
        typeof body.launchToken === "string" ? body.launchToken : launchToken;
      managedPollToken.current = nextLaunchToken;
      if (body.stage === "ready") {
        if (
          typeof body.endpoint !== "string" ||
          typeof body.accessKey !== "string"
        ) {
          stopManagedWithError(
            "Colab reported ready without a valid Gradio connection. Use the manual connection fields."
          );
          return;
        }
        void verifyManagedConnection(
          body.endpoint,
          body.accessKey,
          body.message || "Colab worker is ready."
        );
        return;
      }
      if (body.stage === "error") {
        stopManagedWithError(
          body.message || "The managed Colab worker failed to start."
        );
        return;
      }
      if (body.stage !== "installing" && body.stage !== "loading") {
        stopManagedWithError(
          "Colab returned an unknown runtime stage. Use the manual connection fields."
        );
        return;
      }
      setManagedStage(body.stage);
      setManagedMessage(
        body.message ||
          (body.stage === "installing"
            ? "Installing the Colab worker."
            : "Loading the Colab worker.")
      );
      scheduleManagedPoll(nextLaunchToken);
    } catch (failure) {
      if (managedPollToken.current === launchToken) {
        stopManagedWithError(progressFailureMessage(failure));
      }
    } finally {
      managedPollInFlight.current = false;
    }
  };

  const handleStartManagedRuntime = async (repair = false) => {
    if (
      !colabAuthorized ||
      !colabCsrfToken ||
      busy ||
      managedPollInFlight.current ||
      managedStage === "installing" ||
      managedStage === "loading"
    )
      return;
    if (repair) {
      const confirmed = window.confirm(
        "Repair & reinstall AccentLab?\n\nThis will stop only the verified AccentLab worker (not the Colab T4 runtime), clear only its dedicated managed software checkout and AccentLab bootstrap/status files, then reinstall the pinned backend. It leaves your notebook, Google Drive, uploaded/generated recordings, model cache, Python environment, and unrelated files untouched. It will not use a paid GPU. Continue?"
      );
      if (!confirmed) return;
      disconnect();
    }
    clearManagedPolling();
    setManagedStage("installing");
    setManagedMessage(
      repair
        ? "Preparing a confirmed repair on an eligible free T4 runtime…"
        : "Requesting an eligible free T4 runtime…"
    );
    try {
      const response = await fetch("/api/colab/launch", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-AccentLab-CSRF": colabCsrfToken,
        },
        body: JSON.stringify(
          repair ? { repair: true, confirmation: "REPAIR_ACCENTLAB" } : {}
        ),
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as Partial<ColabLaunchResponse> & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          body.error || "Could not start the free Colab runtime."
        );
      if (
        typeof body.launchToken !== "string" ||
        !body.stage ||
        typeof body.message !== "string"
      ) {
        throw new Error(
          "Colab returned an incomplete launch response. Use the manual connection fields."
        );
      }
      managedPollToken.current = body.launchToken;
      managedPollDeadline.current = Date.now() + COLAB_MAX_POLL_MS;
      setManagedStage(body.stage);
      setManagedMessage(body.message);
      if (body.stage === "ready") {
        if (
          typeof body.endpoint !== "string" ||
          typeof body.accessKey !== "string"
        ) {
          stopManagedWithError(
            "Colab reported ready without a valid Gradio connection. Use the manual connection fields."
          );
          return;
        }
        await verifyManagedConnection(
          body.endpoint,
          body.accessKey,
          body.message
        );
      } else if (body.stage === "error") {
        stopManagedWithError(body.message);
      } else {
        scheduleManagedPoll(body.launchToken);
      }
    } catch (failure) {
      stopManagedWithError(
        failure instanceof Error
          ? failure.message
          : "Could not start the free Colab runtime. Use the manual connection fields."
      );
    }
  };

  const postHuggingFace = async <T,>(
    path: string,
    body: unknown = {}
  ): Promise<T> => {
    const response = await fetch(`/api/huggingface/${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-AccentLab-HF-CSRF": hfCsrfToken,
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as T & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error || "Hugging Face request failed.");
    return result;
  };

  const handleProviderChange = (next: Provider) => {
    if (busy || next === provider) return;
    disconnect();
    setEndpoint("");
    setAccessKey("");
    resetOutput();
    setProvider(next);
    if (next === "huggingface") void refreshHuggingFaceSession(false);
    if (next === "modal") void refreshModalSession();
  };

  const handleStartHuggingFace = async () => {
    if (
      !hfAuthorized ||
      !hfCsrfToken ||
      !hfHardwareConfirmed ||
      hfStage !== "paused" ||
      busy
    )
      return;
    const confirmed = window.confirm(
      `Start the Hugging Face T4-small Space?\n\nPrice: $${hfPrice.toFixed(2)} per running hour, billed by the minute. Charges continue while it is starting or running. Pause the Hugging Face worker when finished; this does not pause Colab or the website. No different hardware will be selected by AccentLab. Start now?`
    );
    if (!confirmed) return;
    setHfStage("starting");
    setHfMessage("Sending the confirmed start request to Hugging Face…");
    try {
      const result = await postHuggingFace<{
        stage: "starting";
        message: string;
      }>("start", { confirmation: "HF_T4_SMALL_040_PER_HOUR" });
      setHfMessage(result.message);
      await refreshHuggingFaceSession(false);
    } catch (failure) {
      setHfStage("error");
      setHfMessage(
        failure instanceof Error
          ? failure.message
          : "Could not start the Hugging Face Space."
      );
    }
  };

  const handlePauseHuggingFace = async () => {
    if (!hfAuthorized || !hfCsrfToken || hfGenerationActive || busy) return;
    const confirmed = window.confirm(
      "Pause the Hugging Face worker? This stops only the Hugging Face Space; it does not pause Colab or the website. The Space can be deliberately started again later."
    );
    if (!confirmed) return;
    setHfStage("pausing");
    setHfMessage("Requesting pause for the Hugging Face worker…");
    try {
      const result = await postHuggingFace<{
        stage: "paused" | "pausing";
        message: string;
      }>("pause");
      if (result.stage === "paused") {
        disconnect();
        setEndpoint("");
        setAccessKey("");
        setHfStage("paused");
      } else {
        setHfStage("pausing");
      }
      setHfMessage(result.message);
      await refreshHuggingFaceSession(false);
    } catch (failure) {
      setHfStage("error");
      setHfMessage(
        failure instanceof Error
          ? failure.message
          : "Could not pause the Hugging Face Space."
      );
      await refreshHuggingFaceSession(false);
    }
  };

  const handleClearExpiredLease = async () => {
    if (!hfAuthorized || !hfCsrfToken || !hfLeaseExpired || !hfLeaseId || busy)
      return;
    const confirmed = window.confirm(
      "The safety lease expired, but the remote Hugging Face job may still be running. First verify in Hugging Face that no generation is active. Clear the safety lock only if you have confirmed the job ended."
    );
    if (!confirmed) return;
    try {
      await postHuggingFace("generation/clear", {
        generationId: hfLeaseId,
        confirmation: "HF_NO_ACTIVE_GENERATION",
      });
      setHfGenerationActive(false);
      setHfLeaseExpired(false);
      setHfLeaseId("");
      setHfMessage("Owner-verified generation safety lease cleared.");
      await refreshHuggingFaceSession(false);
    } catch (failure) {
      setHfMessage(
        failure instanceof Error
          ? failure.message
          : "Could not clear the expired generation safety lease."
      );
    }
  };

  const handleGenerate = async () => {
    const connection = connectionRef.current;
    if (
      !canGenerate ||
      !sourceFile ||
      !accentFile ||
      (provider !== "modal" && !connection)
    )
      return;
    resetOutput();
    setGenerationState("generating");
    const controller = new AbortController();
    generationAbort.current = controller;
    let hfGenerationId: string | undefined;
    let hfHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let keepHfLease = false;
    try {
      if (provider === "huggingface") {
        const lease = await postHuggingFace<{ generationId: string }>(
          "generation/start"
        );
        hfGenerationId = lease.generationId;
        setHfLeaseId(lease.generationId);
        setHfLeaseExpired(false);
        setHfGenerationActive(true);
        setHfStage("generating");
        setHfMessage(
          "Generation is active. Pause is disabled until it finishes."
        );
        hfHeartbeatTimer = setInterval(
          () => {
            void postHuggingFace("generation/heartbeat", {
              generationId: lease.generationId,
            }).catch(() => {
              setHfMessage(
                "The generation lease could not be renewed. Pause remains blocked by the shared safety state."
              );
            });
          },
          2 * 60 * 1000
        );
      }
      const input = {
        sourceVoice: sourceFile,
        accentReference: accentFile,
        script,
        consent,
        laughSample: expression.hasLaughCue ? laughSample : null,
        sobSample: expression.needsSobSample ? sobSample : null,
      };
      const result =
        provider === "modal"
          ? await generateWithModal(
              input,
              modalCsrfToken,
              setProgress,
              controller.signal
            )
          : await connection!.generate(input, setProgress, controller.signal);
      if (!controller.signal.aborted) {
        setOutputBlob(result);
        setGenerationState("complete");
        if (provider === "huggingface") setHfStage("ready");
      }
    } catch (failure) {
      const failureText =
        failure instanceof Error ? failure.message : String(failure);
      keepHfLease =
        provider === "huggingface" &&
        (controller.signal.aborted ||
          /stopped listening|exceeded 15 minutes|may still finish/i.test(
            failureText
          ));
      setError(
        safeGenerationError(
          failure,
          accessKey,
          provider === "huggingface"
            ? "Hugging Face"
            : provider === "modal"
              ? "Modal"
              : "Colab"
        )
      );
      setGenerationState("error");
      if (provider === "huggingface")
        setHfStage(keepHfLease ? "starting" : "error");
      // A failed GPU request must be rechecked before another upload.
      connectionRef.current?.close();
      connectionRef.current = null;
      setConnectionState("disconnected");
      setSampleRate(null);
    } finally {
      if (hfHeartbeatTimer) clearInterval(hfHeartbeatTimer);
      generationAbort.current = null;
      if (hfGenerationId && !keepHfLease) {
        try {
          await postHuggingFace("generation/end", {
            generationId: hfGenerationId,
          });
          setHfGenerationActive(false);
          setHfLeaseId("");
          setHfLeaseExpired(false);
          setHfStage("ready");
          void refreshHuggingFaceSession(false);
        } catch {
          setHfGenerationActive(true);
          setHfStage("generating");
          setHfMessage(
            "Could not confirm that the generation ended; pause remains blocked until its safety lease expires."
          );
        }
      } else if (hfGenerationId && keepHfLease) {
        setHfGenerationActive(true);
        setHfStage("starting");
        setHfMessage(
          "The client stopped listening; the Hugging Face job may still be running. Pause is blocked while its safety lease remains active."
        );
      }
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="AccentLab Studio home">
          <span className="brand-mark">
            <AudioLines size={18} strokeWidth={2.2} />
          </span>
          <span>
            Accent<span>Lab</span> Studio
          </span>
        </a>
        <div className="topbar-right">
          <span className="privacy-chip">
            <LockKeyhole size={13} />{" "}
            {provider === "huggingface"
              ? "Hugging Face Space"
              : provider === "modal"
                ? "Modal serverless worker"
                : "Your Colab session"}
          </span>
        </div>
      </header>
      <main className="page-wrap">
        <section className="intro-row">
          <div>
            <p className="eyebrow">
              <span className="signal-dot" /> Reference voice studio
            </p>
            <h1>
              Keep the voice.
              <br />
              <em>Change the accent.</em>
            </h1>
            <p className="intro-copy">
              Write the exact line, mark where its delivery should shift, and
              optionally add the original speaker’s laugh or giggle. A sob cue
              needs a cry/sob clip. Colab is the default provider. The optional
              Hugging Face worker is explicitly started by its owner; Modal is
              an owner-authorized serverless fallback that runs only when a
              generation is requested and scales down afterward.
            </p>
          </div>
          <div className="intro-note">
            <span className="note-kicker">The brief</span>
            <p>Identity from one recording. Accent from another.</p>
            <span className="note-line" />
            <span className="note-meta">Experimental · results vary</span>
          </div>
        </section>

        <div
          className="provider-choice"
          role="group"
          aria-label="Inference provider"
        >
          <span className="mini-label">Choose inference provider</span>
          <div className="provider-choice-buttons">
            <button
              className={provider === "colab" ? "is-selected" : ""}
              type="button"
              aria-pressed={provider === "colab"}
              disabled={busy}
              onClick={() => handleProviderChange("colab")}
            >
              Google Colab <small>Default · free T4</small>
            </button>
            <button
              className={provider === "huggingface" ? "is-selected" : ""}
              type="button"
              aria-pressed={provider === "huggingface"}
              disabled={busy}
              onClick={() => handleProviderChange("huggingface")}
            >
              Hugging Face <small>Optional · $0.40/hr T4-small</small>
            </button>
            <button
              className={provider === "modal" ? "is-selected" : ""}
              type="button"
              aria-pressed={provider === "modal"}
              disabled={busy}
              onClick={() => handleProviderChange("modal")}
            >
              Modal <small>Optional · serverless T4</small>
            </button>
          </div>
        </div>

        {provider === "colab" && (
          <>
        <section className="colab-panel" aria-labelledby="colab-heading">
          <div className="colab-panel-heading">
            <div>
              <span className="mini-label">Connect the free GPU</span>
              <h2 id="colab-heading">Start or reuse your free T4.</h2>
            </div>
            <span className={`connection-badge ${connectionState}`}>
              <span className="status-dot" />
              {connectionState === "connected"
                ? "GPU connected"
                : connectionState === "connecting"
                  ? "Checking GPU…"
                  : "Not connected"}
            </span>
          </div>
          <p className="colab-instructions">
                For automatic startup, authorize Google below and use the
                managed button. For manual fallback, download the notebook,
                choose a <strong>T4 GPU</strong> in Colab, then run setup,
                restart once, and run the GPU check and final backend cell. Copy
                its URL and session access code. Older notebooks must be
                replaced to use the expressive text-safe pipeline.
          </p>
          <div className="colab-actions">
            <a
              className="colab-link"
              href="/accentlab_seedvc_backend.ipynb"
              download
            >
              Download updated notebook <Download size={14} />
            </a>
            <a
              className="colab-link"
              href="https://colab.research.google.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Google Colab <ArrowUpRight size={14} />
            </a>
          </div>
          <div className="managed-colab" aria-live="polite">
            <div className="managed-colab-copy">
              <span className="mini-label">Managed setup</span>
              <h3>Authorize Google, then start the runtime here.</h3>
              <p>
                    AccentLab can start or reuse its own Google Colab runtime
                    and fill the URL and access code when ready. It never stops
                    or deletes a runtime; Google exposes no direct restart
                    operation. If an existing session is stopped or unavailable,
                    restart it manually in Colab. Only an eligible standard T4
                    on the Free tier is accepted—no paid fallback. Manus server
                    hosting is separate. “Repair &amp; reinstall” asks for
                    confirmation and resets only AccentLab-managed software and
                    worker status; it leaves the runtime, notebook, Drive, and
                    audio files untouched.
              </p>
            </div>
            {colabAuthNotice && (
              <p
                className={`managed-notice ${colabAuthNoticeIsError ? "is-error" : "is-success"}`}
              >
                {colabAuthNotice}
              </p>
            )}
            {colabSessionLoading ? (
              <p className="managed-status">
                <LoaderCircle className="spin" size={14} /> Checking Google
                authorization…
              </p>
            ) : colabConfigured === false ? (
              <p className="managed-notice is-error" role="alert">
                {colabSessionMessage ||
                  "Managed Colab setup is not configured. Manual connection is still available."}
              </p>
            ) : colabConfigured === true && !colabAuthorized ? (
              <a className="managed-cta" href="/api/colab/oauth/start">
                Authorize with Google <ArrowUpRight size={15} />
              </a>
            ) : colabConfigured === true && colabAuthorized ? (
              <div className="managed-runtime-controls">
                <button
                  className="managed-cta managed-start-button"
                  type="button"
                  disabled={
                    busy ||
                    managedStage === "installing" ||
                    managedStage === "loading" ||
                    managedStage === "ready"
                  }
                  onClick={() => void handleStartManagedRuntime()}
                >
                  {managedStage === "installing" ||
                  managedStage === "loading" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : null}
                      {managedStage === "ready" &&
                      connectionState === "connected"
                    ? "Free T4 connected"
                    : managedStage === "installing"
                      ? "Installing worker…"
                      : managedStage === "loading"
                        ? "Loading worker…"
                        : managedStage === "error"
                          ? "Retry safe start/reuse"
                          : "Start or reuse free T4"}
                </button>
                <button
                  className="managed-cta managed-repair-button"
                  type="button"
                  disabled={
                    busy ||
                    managedStage === "installing" ||
                    managedStage === "loading"
                  }
                  onClick={() => void handleStartManagedRuntime(true)}
                >
                  <RotateCcw size={14} /> Repair &amp; reinstall
                </button>
                {managedMessage && (
                  <p
                    className={`managed-status ${managedStage === "error" ? "is-error" : ""}`}
                  >
                    {managedStage === "ready" &&
                    connectionState !== "connected" ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    {managedMessage}
                  </p>
                )}
              </div>
            ) : (
              <p className="managed-notice is-error" role="alert">
                {colabSessionMessage ||
                  "Managed Colab authorization could not be checked. Manual connection is still available."}
              </p>
            )}
          </div>
          <div className="connection-fields">
            <label className="connection-field" htmlFor="colab-url">
              <span>Temporary Gradio URL</span>
              <input
                id="colab-url"
                type="url"
                value={endpoint}
                placeholder="https://your-session.gradio.live"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy || connectionState === "connecting"}
                onChange={event => {
                  managedVerifyAttempt.current += 1;
                  clearManagedPolling();
                  setManagedStage("idle");
                  setManagedMessage("");
                  disconnect();
                  setEndpoint(event.target.value);
                }}
              />
            </label>
            <label className="connection-field" htmlFor="colab-code">
              <span>Session access code</span>
              <input
                id="colab-code"
                type="password"
                value={accessKey}
                placeholder="From the final notebook cell"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy || connectionState === "connecting"}
                onChange={event => {
                  managedVerifyAttempt.current += 1;
                  clearManagedPolling();
                  setManagedStage("idle");
                  setManagedMessage("");
                  disconnect();
                  setAccessKey(event.target.value);
                }}
              />
            </label>
            <button
              className="connect-button"
              type="button"
              disabled={
                busy ||
                connectionState === "connecting" ||
                !endpoint.trim() ||
                !accessKey.trim()
              }
              onClick={
                connectionState === "connected" ? disconnect : handleConnect
              }
            >
              {connectionState === "connecting" ? (
                <>
                  <LoaderCircle className="spin" size={16} /> Checking
                </>
              ) : connectionState === "connected" ? (
                "Disconnect"
              ) : (
                "Check connection"
              )}
            </button>
          </div>
          {connectionError && (
            <p className="connection-error" role="alert">
              <CircleAlert size={15} />
              {connectionError}
            </p>
          )}
          {connectionState === "connected" && (
            <p className="connection-success" role="status">
              <Check size={15} />
              GPU confirmed · output{" "}
              {sampleRate ? `${sampleRate / 1000} kHz` : "WAV"}.
              Identity-anchored model loaded and ready.
            </p>
          )}
          <p className="session-note">
                Free Colab may disconnect without warning. Google says managed
                free runtimes may terminate web-UI content-generation jobs and
                lists deepfakes as prohibited; voice conversion may be covered.
                Confirm this use complies with the{" "}
                <a
                  href="https://research.google.com/colaboratory/faq.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Colab FAQ
                </a>
                . Interrupted takes are not saved; a retry starts the whole
                script from the beginning. Reconnect before retrying. URL and
                access code stay only in this page’s memory; don’t share them.
              </p>
            </section>
          </>
        )}

        {provider === "huggingface" && (
          <section
            className="colab-panel huggingface-panel"
            aria-labelledby="huggingface-heading"
          >
            <div className="colab-panel-heading">
              <div>
                <span className="mini-label">Optional paid fallback</span>
                <h2 id="huggingface-heading">Hugging Face T4-small worker</h2>
              </div>
              <span
                className={`connection-badge ${hfStage === "ready" ? "connected" : hfStage === "starting" || hfStage === "generating" || hfStage === "pausing" ? "connecting" : ""}`}
              >
                <span className="status-dot" />
                {hfStage === "paused"
                  ? "Paused"
                  : hfStage === "starting"
                    ? "Starting"
                    : hfStage === "ready"
                      ? "Ready"
                      : hfStage === "generating"
                        ? "Generating"
                        : hfStage === "pausing"
                          ? "Pausing"
                          : "Error"}
              </span>
            </div>
            <p className="colab-instructions">
              T4-small costs{" "}
              <strong>
                ${hfPrice.toFixed(2)} per running hour, billed by the minute
              </strong>{" "}
              while starting or running. The Space must already exist and be
              configured as T4-small; enabling GPU may require an eligible plan
              and billing setup, which this website never enables. AccentLab
              will not create it, change hardware, or start it automatically.
              This fallback template has not been validated on a live Hugging
              Face T4-small; do not rely on it until the full v5 checks pass
              there. Hugging Face controls are restricted to the allowlisted,
              verified Google account.
            </p>
            {hfAuthNotice && (
              <p className="managed-notice" role="status">
                {hfAuthNotice}
              </p>
            )}
            {hfSessionLoading ? (
              <p className="managed-status">
                <LoaderCircle className="spin" size={14} /> Checking Hugging
                Face configuration without starting compute…
              </p>
            ) : hfConfigured === false ? (
              <p className="managed-notice" role="status">
                {hfMessage ||
                  "Hugging Face is not configured. No Space or paid worker has been created."}
              </p>
            ) : !hfAuthorized ? (
              <div className="managed-runtime-controls">
                <a className="managed-cta" href="/api/huggingface/oauth/start">
                  Authorize owner Google account <ArrowUpRight size={15} />
                </a>
                <p className="managed-status">
                  Only the server-side allowlisted Google account can obtain
                  control access. The Hugging Face token is never sent to this
                  page.
                </p>
              </div>
            ) : (
              <div className="managed-runtime-controls">
                <button
                  className="colab-link"
                  type="button"
                  onClick={() => void refreshHuggingFaceSession(false)}
                >
                  Refresh Space status
                </button>
                {hfStage === "paused" && (
                  <button
                    className="managed-cta managed-start-button"
                    type="button"
                    disabled={
                      busy || hfGenerationActive || !hfHardwareConfirmed
                    }
                    onClick={() => void handleStartHuggingFace()}
                  >
                    Start T4-small · ${hfPrice.toFixed(2)}/hour
                  </button>
                )}
                {hfStage === "paused" && !hfHardwareConfirmed && (
                  <p className="managed-notice" role="status">
                    The Space must already request T4-small in its Hugging Face
                    hardware settings. AccentLab will not change hardware or
                    send a start request until the server confirms this exact
                    type.
                  </p>
                )}
                {hfStage === "starting" && (
                  <p className="managed-status">
                    <LoaderCircle className="spin" size={14} /> Starting/loading
                    the paused T4-small Space…
                  </p>
                )}
                {hfStage === "ready" && connectionState !== "connected" && (
                  <button
                    className="managed-cta managed-start-button"
                    type="button"
                    disabled={
                      busy ||
                      !hfSpaceUrl ||
                      !hfAccessKey ||
                      connectionState === "connecting"
                    }
                    onClick={() =>
                      void connectWithCredentials(
                        hfSpaceUrl,
                        hfAccessKey,
                        "Hugging Face"
                      )
                    }
                  >
                    {connectionState === "connecting" ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : null}
                    Connect to ready worker
                  </button>
                )}
                {hfRuntimeRunning && (
                  <button
                    className="managed-cta managed-repair-button"
                    type="button"
                    disabled={
                      busy || hfGenerationActive || hfStage === "pausing"
                    }
                    onClick={() => void handlePauseHuggingFace()}
                  >
                    {hfStage === "pausing" ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : null}
                    Pause Hugging Face worker
                  </button>
                )}
                {hfGenerationActive && (
                  <p className="managed-notice is-error" role="status">
                    A generation may still be active. Pause is blocked while its
                    durable safety lease is active.
                  </p>
                )}
                {hfGenerationActive && hfLeaseExpired && (
                  <>
                    <p className="managed-notice is-error" role="alert">
                      The one-hour lease expired, but the remote job may still
                      be running. Check the Hugging Face Space before clearing
                      this lock.
                    </p>
                    <button
                      className="colab-link"
                      type="button"
                      onClick={() => void handleClearExpiredLease()}
                    >
                      I verified no generation is active — clear safety lock
                    </button>
                  </>
                )}
                {hfMessage && (
                  <p
                    className={`managed-status ${hfStage === "error" ? "is-error" : ""}`}
                    role="status"
                  >
                    {hfStage === "starting" || hfStage === "pausing" ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    {hfMessage}
                  </p>
                )}
              </div>
            )}
            <p className="session-note">
              Starting requires a separate confirmation displaying the T4-small
              price. Pause stops only the Hugging Face worker—not Colab or this
              website. Inputs are uploaded only when you generate and the Space
              deletes those uploads after the attempt; no Google Drive access is
              used. If you stop listening, the worker may continue the current
              take, so pause remains blocked for the safety lease.
          </p>
        </section>
        )}

        {provider === "modal" && (
          <section
            className="colab-panel modal-panel"
            aria-labelledby="modal-heading"
          >
            <div className="colab-panel-heading">
              <div>
                <span className="mini-label">Optional paid fallback</span>
                <h2 id="modal-heading">Modal serverless v5 worker</h2>
              </div>
              <span
                className={`connection-badge ${modalAuthorized ? "connected" : ""}`}
              >
                <span className="status-dot" />
                {modalSessionLoading
                  ? "Checking"
                  : modalAuthorized
                    ? "Owner verified"
                    : "Not authorized"}
              </span>
            </div>
            <p className="colab-instructions">
              Modal does not keep a paid GPU running between takes. Selecting
              this provider alone starts nothing; each authorized Generate
              action sends one request to the serverless T4, which scales down
              after the job. There is no separate warm-start or pause button.
              Usage charges are still possible while the request runs. Before
              adding deployment credentials, set a <strong>$10 Workspace
              budget and a $10 spend limit in Modal</strong>; the website cannot
              enforce that billing cap. No Modal compute or billing is enabled
              by local development or this status check.
            </p>
            {modalAuthNotice && (
              <p className="managed-notice" role="status">
                {modalAuthNotice}
              </p>
            )}
            {modalSessionLoading ? (
              <p className="managed-status">
                <LoaderCircle className="spin" size={14} /> Checking Modal
                configuration without starting compute…
              </p>
            ) : modalConfigured === false ? (
              <p className="managed-notice" role="status">
                {modalMessage ||
                  "Modal is not configured. No worker has been started and no paid compute has been enabled."}
              </p>
            ) : modalConfigured === null ? (
              <p className="managed-notice is-error" role="alert">
                {modalMessage || "Modal configuration could not be checked."}
              </p>
            ) : !modalAuthorized ? (
              <div className="managed-runtime-controls">
                <a className="managed-cta" href="/api/modal/oauth/start">
                  Authorize owner Google account <ArrowUpRight size={15} />
                </a>
                <p className="managed-status">
                  Only the server-side verified Google allowlist can generate
                  through the protected proxy. Worker credentials never reach
                  this page.
                </p>
              </div>
            ) : (
              <div className="managed-runtime-controls">
                <button
                  className="colab-link"
                  type="button"
                  onClick={() => void refreshModalSession()}
                >
                  Refresh Modal authorization
                </button>
                <p className="managed-status">
                  Owner verified. Modal starts only when you press Generate; no
                  automatic retries are sent. If you stop listening, the
                  worker may finish the in-flight request before scaling down.
                </p>
              </div>
            )}
            <p className="session-note">
              Inputs are forwarded only with an authorized generation request
              and are held in temporary worker storage for the attempt. Do not
              upload sensitive recordings or scripts. Modal must be deployed
              separately; this project does not create a Workspace, set limits,
              enable billing, or deploy a worker automatically.
            </p>
          </section>
        )}

        <div className="stage-line" aria-hidden="true">
          <span className="stage-line-fill" />
        </div>
        <section className="workspace-grid">
          <aside className="voice-column">
            <div className="section-label">
              <span>01</span> Reference recordings
            </div>
            <div className="reference-stack">
              <UploadCard
                kind="source"
                file={sourceFile}
                disabled={busy}
                onSelect={file => setFile("source", file)}
                onClear={() => {
                  setSourceFile(null);
                  resetOutput();
                }}
              />
              <UploadCard
                kind="accent"
                file={accentFile}
                disabled={busy}
                onSelect={file => setFile("accent", file)}
                onClear={() => {
                  setAccentFile(null);
                  resetOutput();
                }}
              />
            </div>
            <div className="voice-checklist">
              <div className="check-row">
                <span className={`check ${sourceFile ? "active" : ""}`}>
                  {sourceFile && <Check size={12} />}
                </span>
                <span>Original voice reference loaded</span>
              </div>
              <div className="check-row">
                <span className={`check ${accentFile ? "active" : ""}`}>
                  {accentFile && <Check size={12} />}
                </span>
                <span>Accent reference loaded</span>
              </div>
              <p className="reference-tip">
                Use one clear speaker per file, ideally 10–25 seconds of natural
                speech without music. The updated notebook trims edge silence
                and uses up to 25 seconds. The original recording guides voice
                identity and the second guides accent/style, but the model does
                not perfectly separate those qualities.
              </p>
            </div>
          </aside>

          <section className="script-column">
            <div className="section-label">
              <span>02</span> Script &amp; expression
            </div>
            <div className="script-card">
              <div className="script-toolbar">
                <span className="mini-label">Message draft + cues</span>
                <span className="script-meta">English · exact words</span>
              </div>
              <textarea
                ref={scriptInput}
                aria-label="Words to be spoken with expression cues"
                value={script}
                disabled={busy}
                onChange={event => {
                  setScript(event.target.value);
                  resetOutput();
                }}
                placeholder="Write the words you want spoken..."
                maxLength={MAX_SCRIPT_LENGTH}
              />
              <div className="expression-cue-toolbar">
                <div className="cue-group">
                  <span className="mini-label">Mood</span>
                  <div className="cue-buttons">
                    {(
                      ["neutral", "playful", "excited", "sad", "calm"] as const
                    ).map(mood => (
                      <button
                        className="cue-button"
                        key={mood}
                        type="button"
                        disabled={busy}
                        onClick={() => insertExpressionCue(`[mood:${mood}]`)}
                      >
                        {mood}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cue-group">
                  <span className="mini-label">Vocal moment</span>
                  <div className="cue-buttons">
                    {(
                      [
                      ["laugh", "Laugh"],
                      ["giggle", "Giggle"],
                      ["sob", "Sob"],
                      ] as const
                    ).map(([cue, label]) => (
                      <button
                        className="cue-button cue-button-event"
                        key={cue}
                        type="button"
                        disabled={busy}
                        onClick={() => insertExpressionCue(`[${cue}]`)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="script-footer">
                <span className="tip">
                  <Sparkles size={13} /> Punctuation shapes pauses; cues are
                  removed before speech.
                </span>
                <span className="char-count">{script.length} / 1,200</span>
              </div>
            </div>
            <div className="expression-sample-panel">
              <div className="sample-panel-heading">
                <span className="mini-label">
                  Original-speaker vocal samples
                </span>
                <p>
                  Laugh/giggle clips are optional; without one, those cues are
                  skipped. A [sob] cue needs a clip. Only matching event clips
                  upload.
                </p>
              </div>
              <div className="expression-samples">
                <UploadCard
                  kind="laugh"
                  file={laughSample}
                  disabled={busy}
                  onSelect={file => setFile("laugh", file)}
                  onClear={() => {
                    setLaughSample(null);
                    resetOutput();
                  }}
                />
                <UploadCard
                  kind="sob"
                  file={sobSample}
                  disabled={busy}
                  onSelect={file => setFile("sob", file)}
                  onClear={() => {
                    setSobSample(null);
                    resetOutput();
                  }}
                />
              </div>
              <p
                className={`expression-status ${expression.missingSamples.length || expression.tooManyVocalizations ? "is-error" : ""}`}
                aria-live="polite"
              >
                {expression.tooManyVocalizations
                  ? "Use no more than six laugh, giggle, or sob cues in one take."
                  : expression.missingSamples.length
                    ? `Add the original speaker’s ${expression.missingSamples.join(" and ")} sample to use those cues.${expression.hasLaughCue && !laughSample ? " Laugh/giggle cues remain optional and will be skipped without their clip." : ""}`
                    : expression.hasLaughCue &&
                        !laughSample &&
                        !expression.hasSpeech
                      ? "A laugh clip is optional when speech is present; a laugh-only take needs the clip or spoken words."
                      : expression.hasLaughCue && !laughSample
                      ? "The laugh/giggle sample is optional. These cues will be skipped; no laugh sound is generated."
                      : "Mood shifts are approximate. Supplied laugh/giggle clips are inserted; a [sob] cue requires its matching clip."}
              </p>
            </div>
            <div className="script-preview-row">
              <div>
                <span className="muted-label">Estimated speech</span>
                <strong>{estimatedSeconds}</strong>
              </div>
              <div>
                <span className="muted-label">Delivery</span>
                <strong>Cue-directed · approximate</strong>
              </div>
              <button
                className="reset-button"
                type="button"
                disabled={!hasScript || busy}
                onClick={() => {
                  setScript("");
                  resetOutput();
                }}
              >
                <RotateCcw size={13} /> Clear
              </button>
            </div>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy}
                onChange={event => setConsent(event.target.checked)}
              />
              <span>
                I have permission from both reference speakers, and from the
                original speaker for any laugh/giggle or cry/sob sample, to
                process these recordings through a temporary{" "}
                {provider === "huggingface"
                  ? "Hugging Face Space and Gradio session"
                  : provider === "modal"
                    ? "Modal serverless worker"
                    : "Colab and Gradio session"}
                .
              </span>
            </label>
          </section>

          <aside className="output-column">
            <div className="section-label">
              <span>03</span> New recording
            </div>
            <div
              className={`output-card ${generationState === "error" ? "needs-provider" : ""}`}
              aria-live="polite"
            >
              {busy ? (
                <div className="generation-output">
                  <LoaderCircle className="spin" size={30} />
                  <span className="mini-label">
                    {provider === "huggingface"
                      ? "Hugging Face conversion"
                      : provider === "modal"
                        ? "Modal serverless conversion"
                        : "Colab conversion"}
                  </span>
                  <h2>Creating your new recording.</h2>
                  <p>{progress.message}</p>
                  {typeof progress.fraction === "number" && (
                    <progress
                      max={1}
                      value={progress.fraction}
                      aria-label="Conversion progress"
                    />
                  )}
                  <p className="output-caveat">
                    Pronunciation Guard checks every requested word locally
                    after conversion. Mood cues use small pitch/rate shifts and
                    may sound subtle. Supplied event clips are inserted;
                    laugh/giggle cues without an optional clip are skipped.{" "}
                    {provider === "huggingface"
                      ? "Hugging Face may queue or pause; this"
                      : provider === "modal"
                        ? "Modal may cold-start; stopping the browser wait does not guarantee the remote job stopped. This"
                        : "Free Colab may disconnect; this"}
                    take cannot resume mid-script, and retrying starts from the
                    beginning.
                  </p>
                </div>
              ) : generationState === "complete" && outputUrl ? (
                <div className="completed-output">
                  <span className="completed-icon">
                    <Check size={23} />
                  </span>
                  <span className="mini-label">Converted result</span>
                  <h2>Listen to your new take.</h2>
                  <audio
                    controls
                    preload="metadata"
                    src={outputUrl}
                    aria-label="Converted audio preview"
                  />
                  <a
                    className="download-button"
                    href={outputUrl}
                    download="accentlab_result.wav"
                  >
                    <Download size={16} /> Download WAV
                  </a>
                  <p className="output-caveat">
                    Compare this take with both references. Mood delivery is
                    approximate; supplied vocal moments are speaker clips.
                    {expression.hasLaughCue && !laughSample
                      ? " Laugh/giggle cues without a clip were skipped."
                      : ""}
                    Identity, naturalness, accent, and an 85–95% likeness are
                    not guaranteed.
                  </p>
                </div>
              ) : generationState === "error" ? (
                <div className="provider-message" role="alert">
                  <div className="provider-icon">
                    <CircleAlert size={21} />
                  </div>
                  <span className="mini-label">Action needed</span>
                  <h2>Let’s check this take.</h2>
                  <p>{error}</p>
                  <button
                    className="outline-button"
                    type="button"
                    onClick={resetOutput}
                  >
                    Back to draft
                  </button>
                </div>
              ) : (
                <div className="empty-output">
                  <div className="output-orbit">
                    <span className="orbit-dot" />
                    <Mic2 size={23} />
                  </div>
                  <span className="mini-label">Waiting for your take</span>
                  <h2>Your new line will land here.</h2>
                  <p>
                    {provider === "modal"
                      ? modalAuthorized
                        ? "Load both references, write your line, add cues if useful, and confirm permission. Generate sends one owner-authorized request to Modal.": "Authorize the allowlisted owner account above, then load both references and draft your line."
                      : connectionState === "connected"
                      ? "Load both references, write your line, add cues if useful, and confirm permission."
                      : `Connect ${provider === "huggingface" ? "the Hugging Face worker" : "Colab"} above, load both references, then write your line and cue its delivery.`}
                  </p>
                  <div className="output-spec">
                    <span>Output</span>
                    <strong>
                      WAV ·{" "}
                      {sampleRate ? `${sampleRate / 1000} kHz` : "model rate"}
                    </strong>
                  </div>
                </div>
              )}
            </div>
            <button
              className="generate-button"
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              <Wand2 size={17} />
              {busy
                ? `Converting on ${provider === "huggingface" ? "Hugging Face" : provider === "modal" ? "Modal" : "Colab"}…`
                : "Generate voice preview"}
              <ArrowUpRight size={16} />
            </button>
            {busy && (
              <button
                className="stop-button"
                type="button"
                onClick={() => generationAbort.current?.abort()}
              >
                {provider === "modal"
                  ? "Stop waiting (Modal job may continue)"
                  : "Stop listening to this job"}
              </button>
            )}
            <p className="provider-note">
              <LockKeyhole size={12} />
              References upload when generating; event clips only upload when
              cued.
            </p>
          </aside>
        </section>

        <section className="experimental-note">
          <CircleAlert size={18} />
          <p>
            <strong>
              An experimental voice-conversion tool, not a perfect voice clone.
            </strong>{" "}
            The current identity-anchored v5 expressive pipeline retains the v3
            two-pass text-safe baseline, chunks speech, and verifies spoken
            words before returning audio. The original recording guides identity
            and the accent reference guides accent/style; the model does not
            perfectly separate them. Mood cues only apply small supported
            pitch/rate changes, so their effect is approximate. A laugh/giggle
            clip is optional; without one, those cues are skipped. A sob cue
            requires the original speaker’s supplied cry/sob clip. AccentLab
            does not claim to synthesize those sounds. Write your own joke and
            mark its delivery—jokes are not generated or detected automatically.
            No 85–95% speaker-similarity guarantee is available. Microsoft’s
            Edge speech service receives the script to make a temporary
            scaffold; Seed-VC must produce the final converted speech. Audio
            passes through a temporary Gradio session for Colab and Hugging Face;
            Modal receives one request through a protected server proxy. The Hugging Face template does not attach
            persistent storage; it deletes input uploads after each attempt and
            automatically cleans orphaned cache entries and returned audio after
            a short temporary window. No Google Drive is used. Don’t use
            sensitive scripts or recordings.
          </p>
        </section>
        <section className="how-it-works">
          <div className="how-title">
            <span className="eyebrow">A considered workflow</span>
            <h2>Two references. Your directed take.</h2>
          </div>
          <div className="how-step">
            <span className="how-number">01</span>
            <strong>Identify</strong>
            <p>Upload the original speaker recording.</p>
          </div>
          <div className="how-step">
            <span className="how-number">02</span>
            <strong>Guide</strong>
            <p>Upload the French-accent reference.</p>
          </div>
          <div className="how-step">
            <span className="how-number">03</span>
            <strong>Generate</strong>
            <p>
              {provider === "huggingface"
                ? "Hugging Face converts verified speech and places marked voice moments."
                : provider === "modal"
                  ? "Modal serverless converts verified speech and places marked voice moments on an owner-requested take."
                  : "Colab converts verified speech and places marked voice moments."}
            </p>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span>ACCENTLAB / EXPERIMENTAL VOICE WORKSPACE</span>
        <span>
          Built for careful takes <AudioLines size={13} />
        </span>
      </footer>
    </div>
  );
}
