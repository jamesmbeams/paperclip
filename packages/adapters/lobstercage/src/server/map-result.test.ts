import { describe, it, expect } from "vitest";
import { mapRuntimeRunToResult } from "./map-result.js";

describe("mapRuntimeRunToResult", () => {
  it("maps completed → exitCode 0 with summary from result.outcome", () => {
    const result = mapRuntimeRunToResult({
      version: "v1",
      runtimeRunId: "rt-1",
      runId: "run-1",
      status: "completed",
      startedAt: "2026-04-18T00:00:00Z",
      lastActivityAt: "2026-04-18T00:00:10Z",
      completedAt: "2026-04-18T00:00:10Z",
      result: {
        status: "completed",
        outcome: { summary: "issue resolved", comment: "LGTM" },
        error: null,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("issue resolved");
    expect(result.resultJson).toEqual({
      status: "completed",
      outcome: { summary: "issue resolved", comment: "LGTM" },
      error: null,
    });
  });

  it("maps failed → exitCode 1 with errorCode and errorMessage passed through from result.error", () => {
    const result = mapRuntimeRunToResult({
      version: "v1",
      runtimeRunId: "rt-2",
      runId: "run-2",
      status: "failed",
      startedAt: "x",
      lastActivityAt: "x",
      completedAt: "x",
      result: {
        status: "failed",
        error: { code: "upstream_fetch_failed", message: "issue not found" },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("upstream_fetch_failed");
    expect(result.errorMessage).toBe("issue not found");
    expect(result.timedOut).toBe(false);
  });

  it("maps blocked → runner_blocked, errorMessage from result.outcome.comment, tolerates result.error === null", () => {
    const result = mapRuntimeRunToResult({
      version: "v1",
      runtimeRunId: "rt-3",
      runId: "run-3",
      status: "blocked",
      startedAt: "x",
      lastActivityAt: "x",
      completedAt: "x",
      result: {
        status: "blocked",
        outcome: {
          summary: "ownership_conflict",
          comment: "issue is owned by another agent",
        },
        error: null,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("runner_blocked");
    expect(result.errorMessage).toBe("issue is owned by another agent");
  });

  it("maps cancelled → errorCode from result.error.code (e.g. cancel_requested)", () => {
    const result = mapRuntimeRunToResult({
      version: "v1",
      runtimeRunId: "rt-4",
      runId: "run-4",
      status: "cancelled",
      startedAt: "x",
      lastActivityAt: "x",
      completedAt: "x",
      result: {
        status: "cancelled",
        error: { code: "cancel_requested", message: "" },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("cancel_requested");
  });

  it("maps a terminal status with missing result → lobstercage_unexpected_runtime_result", () => {
    const result = mapRuntimeRunToResult({
      version: "v1",
      runtimeRunId: "rt-5",
      runId: "run-5",
      status: "completed",
      startedAt: "x",
      lastActivityAt: "x",
      completedAt: "x",
      result: null,
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_unexpected_runtime_result");
  });

  it("still returns exitCode 0 when completed with empty summary (don't conflate empty with failure)", () => {
    const result = mapRuntimeRunToResult({
      version: "v1",
      runtimeRunId: "rt-6",
      runId: "run-6",
      status: "completed",
      startedAt: "x",
      lastActivityAt: "x",
      completedAt: "x",
      result: { status: "completed", outcome: { summary: "" }, error: null },
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("");
  });
});
