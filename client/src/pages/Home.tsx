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
import { analyzeExpressionScript } from "@/lib/expression-cues";

type RecordingKind = "source" | "accent" | "laugh" | "sob";
type GenerationState = "idle" | "generating" | "complete" | "error";
type ConnectionState = "disconnected" | "connecting" | "connected";
type ManagedStage = "idle" | "installing" | "loading" | "ready" | "error";

interface ColabSessionResponse {
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
  const mountedRef = useRef(true);
  const busy = generationState === "generating";
  const hasScript = Boolean(script.trim());
  const expression = useMemo(
    () => analyzeExpressionScript(script, Boolean(laughSample), Boolean(sobSample)),
    [script, laughSample, sobSample]
  );
  const canGenerate = Boolean(
    sourceFile &&
      accentFile &&
      (expression.hasSpeech || expression.hasRenderableVocalization) &&
      expression.missingSamples.length === 0 &&
      !expression.tooManyVocalizations &&
      consent &&
      connectionState === "connected" &&
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
    rawAccessKey: string
  ): Promise<boolean> => {
    if (busy) return false;
    disconnect();
    const attempt = ++connectionAttempt.current;
    setConnectionState("connecting");
    setConnectionError("");
    try {
      const connection = await ColabConnection.connect(
        rawEndpoint,
        rawAccessKey
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
      setConnectionError(safeError(failure, rawAccessKey));
      return false;
    }
  };

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

  const handleGenerate = async () => {
    const connection = connectionRef.current;
    if (!canGenerate || !sourceFile || !accentFile || !connection) return;
    resetOutput();
    setGenerationState("generating");
    const controller = new AbortController();
    generationAbort.current = controller;
    try {
      const result = await connection.generate(
        {
          sourceVoice: sourceFile,
          accentReference: accentFile,
          script,
          consent,
          laughSample: expression.hasLaughCue ? laughSample : null,
          sobSample: expression.needsSobSample ? sobSample : null,
        },
        setProgress,
        controller.signal
      );
      if (!controller.signal.aborted) {
        setOutputBlob(result);
        setGenerationState("complete");
      }
    } catch (failure) {
      setError(safeGenerationError(failure, accessKey));
      setGenerationState("error");
      // A failed GPU request must be rechecked before another upload.
      connectionRef.current?.close();
      connectionRef.current = null;
      setConnectionState("disconnected");
      setSampleRate(null);
    } finally {
      generationAbort.current = null;
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
            <LockKeyhole size={13} /> Your Colab session
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
              needs a cry/sob clip. AccentLab keeps the experimental two-reference
              conversion on your free T4.
            </p>
          </div>
          <div className="intro-note">
            <span className="note-kicker">The brief</span>
            <p>Identity from one recording. Accent from another.</p>
            <span className="note-line" />
            <span className="note-meta">Experimental · results vary</span>
          </div>
        </section>

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
            For automatic startup, authorize Google below and use the managed
            button. For manual fallback, download the notebook, choose a{" "}
            <strong>T4 GPU</strong> in Colab, then run setup, restart once, and
            run the GPU check and final backend cell. Copy its URL and session
            access code. Older notebooks must be replaced to use the expressive
            text-safe pipeline.
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
                AccentLab can start or reuse its own Google Colab runtime and
                fill the URL and access code when ready. It never stops or
                deletes a runtime; Google exposes no direct restart operation.
                If an existing session is stopped or unavailable, restart it
                manually in Colab. Only an eligible standard T4 on the Free tier
                is accepted—no paid fallback. Manus server hosting is separate.
                “Repair &amp; reinstall” asks for confirmation and resets only
                AccentLab-managed software and worker status; it leaves the
                runtime, notebook, Drive, and audio files untouched.
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
                  {managedStage === "ready" && connectionState === "connected"
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
            Free Colab may disconnect without warning. Google says managed free
            runtimes may terminate web-UI content-generation jobs and lists
            deepfakes as prohibited; voice conversion may be covered. Confirm
            this use complies with the <a href="https://research.google.com/colaboratory/faq.html" target="_blank" rel="noreferrer">Colab FAQ</a>.
            Interrupted takes are not saved; a retry starts the whole script
            from the beginning. Reconnect before retrying. URL and access code
            stay only in this page’s memory; don’t share them.
          </p>
        </section>

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
                    {(["neutral", "playful", "excited", "sad", "calm"] as const).map(mood => (
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
                    {([
                      ["laugh", "Laugh"],
                      ["giggle", "Giggle"],
                      ["sob", "Sob"],
                    ] as const).map(([cue, label]) => (
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
                  <Sparkles size={13} /> Punctuation shapes pauses; cues are removed before speech.
                </span>
                <span className="char-count">{script.length} / 1,200</span>
              </div>
            </div>
            <div className="expression-sample-panel">
              <div className="sample-panel-heading">
                <span className="mini-label">Original-speaker vocal samples</span>
                <p>
                  Laugh/giggle clips are optional; without one, those cues are
                  skipped. A [sob] cue needs a clip. Only matching event clips upload.
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
                    : expression.hasLaughCue && !laughSample && !expression.hasSpeech
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
                process these recordings through temporary Colab and Gradio sessions.
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
                  <span className="mini-label">Colab conversion</span>
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
                    Pronunciation Guard checks every requested word locally after conversion.
                    Mood cues use small pitch/rate shifts and may sound subtle.
                    Supplied event clips are inserted; laugh/giggle cues without
                    an optional clip are skipped. Free Colab may disconnect; this
                    take cannot resume mid-script, and retrying starts from the beginning.
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
                    {connectionState === "connected"
                      ? "Load both references, write your line, add cues if useful, and confirm permission."
                      : "Connect Colab above, load both references, then write your line and cue its delivery."}
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
              {busy ? "Converting on Colab…" : "Generate voice preview"}
              <ArrowUpRight size={16} />
            </button>
            {busy && (
              <button
                className="stop-button"
                type="button"
                onClick={() => generationAbort.current?.abort()}
              >
                Stop listening to this job
              </button>
            )}
            <p className="provider-note">
              <LockKeyhole size={12} />
              References upload when generating; event clips only upload when cued.
            </p>
          </aside>
        </section>

        <section className="experimental-note">
          <CircleAlert size={18} />
          <p>
            <strong>
              An experimental voice-conversion tool, not a perfect voice clone.
            </strong>{" "}
            The current identity-anchored v5 expressive pipeline retains the
            v3 two-pass text-safe baseline, chunks speech, and verifies spoken
            words before returning audio.
            The original recording guides identity and the accent reference
            guides accent/style; the model does not perfectly separate them.
            Mood cues only apply small supported pitch/rate changes, so their
            effect is approximate. A laugh/giggle clip is optional; without one,
            those cues are skipped. A sob cue requires the original speaker’s
            supplied cry/sob clip. AccentLab does not claim to synthesize those
            sounds. Write your own joke and mark its
            delivery—jokes are not generated or detected automatically. No
            85–95% speaker-similarity guarantee is available. Microsoft’s Edge
            speech service receives the script to make a temporary scaffold;
            Seed-VC must produce the final converted speech. Audio passes
            through Gradio sharing and is processed temporarily on Colab. Don’t
            use sensitive scripts or recordings.
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
            <p>Colab converts verified speech and places marked voice moments.</p>
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
