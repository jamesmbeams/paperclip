import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/**
 * Shape of `GET /paperclip/runs/:id` as returned by LobsterCage's
 * cage-manager (APT-710 / APT-712). We type it loosely here since we
 * only consume a subset and the cage is the source of truth.
 */
export interface RuntimeRunStatusResponse {
  version?: string;
  runtimeRunId?: string;
  runId?: string;
  status:
    | "queued"
    | "accepted"
    | "preparing"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled"
    | string;
  startedAt?: string | null;
  lastActivityAt?: string | null;
  completedAt?: string | null;
  result?: RuntimeTerminalResult | null;
}

export interface RuntimeTerminalResult {
  status?: "completed" | "failed" | "blocked" | "cancelled" | string;
  outcome?: {
    summary?: string;
    comment?: string;
  };
  error?: { code?: string; message?: string } | null;
}

const UNEXPECTED_CODE = "lobstercage_unexpected_runtime_result";

export function mapRuntimeRunToResult(
  body: RuntimeRunStatusResponse,
): AdapterExecutionResult {
  const { status, result } = body;

  if (status === "completed") {
    if (!result) return unexpected("completed without result");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: typeof result.outcome?.summary === "string" ? result.outcome.summary : "",
      resultJson: result as unknown as Record<string, unknown>,
    };
  }

  if (status === "blocked") {
    if (!result) return unexpected("blocked without result");
    const message =
      result.outcome?.comment ?? result.outcome?.summary ?? "runner reported blocked";
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "runner_blocked",
      errorMessage: message,
      resultJson: result as unknown as Record<string, unknown>,
    };
  }

  if (status === "failed" || status === "cancelled") {
    if (!result) return unexpected(`${status} without result`);
    const fallback = status === "cancelled" ? "runner_cancelled" : "runner_failed";
    const code = result.error?.code?.trim() ? result.error.code : fallback;
    const message = result.error?.message ?? "";
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: code,
      errorMessage: message,
      resultJson: result as unknown as Record<string, unknown>,
    };
  }

  return unexpected(`unexpected terminal status: ${status}`);
}

function unexpected(message: string): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: UNEXPECTED_CODE,
    errorMessage: message,
  };
}
