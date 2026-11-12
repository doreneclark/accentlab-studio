// Managed progress diagnostics must never include a proxy body, request URL,
// cookies, or arbitrary browser exception text.
export class ColabProgressResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColabProgressResponseError";
  }
}

export function progressHttpDiagnostic(response: Response): string {
  const mime = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const contentType = ["application/json", "text/html", "text/plain"].includes(
    mime
  )
    ? mime
    : /^application\/[a-z0-9.+-]{1,60}\+json$/.test(mime)
      ? "application/*+json"
      : mime
        ? "other content type"
        : "unknown content type";
  return `Progress request returned HTTP ${response.status} (${contentType}). Refresh AccentLab and retry; if it persists, share this status.`;
}

export async function readProgressResponse(
  response: Response
): Promise<Record<string, unknown>> {
  const mime = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    mime !== "application/json" &&
    !/^application\/[a-z0-9.+-]{1,60}\+json$/.test(mime)
  ) {
    throw new ColabProgressResponseError(progressHttpDiagnostic(response));
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ColabProgressResponseError(progressHttpDiagnostic(response));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ColabProgressResponseError(progressHttpDiagnostic(response));
  }
  return value as Record<string, unknown>;
}

export function progressFailureMessage(failure: unknown): string {
  if (failure instanceof ColabProgressResponseError) return failure.message;
  if (failure instanceof Error && failure.name === "AbortError") {
    return "The Colab progress request timed out. Refresh AccentLab and retry, or use the manual connection fields.";
  }
  if (failure instanceof TypeError) {
    return "A network error interrupted Colab progress. Check your internet connection, refresh AccentLab and retry, or use the manual connection fields.";
  }
  return "Could not read Colab runtime progress. Refresh AccentLab and retry, or use the manual connection fields.";
}
