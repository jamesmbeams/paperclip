/**
 * Poll the LobsterCage status endpoint until the heartbeat completes,
 * the cage hibernates, or the deadline is exceeded.
 */

export interface PollResult {
  completed: boolean;
  timedOut: boolean;
  cageStatus: string;
  summary: string;
}

export interface StatusResponse {
  available: boolean;
  status: string;
  heartbeat?: {
    enabled: boolean;
    possiblyActive: boolean;
    lastStart: number | null;
    lastEnd: number | null;
  };
}

export async function pollForCompletion(
  statusUrl: string,
  invokeTime: number,
  deadlineMs: number,
  pollIntervalMs: number,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<PollResult> {
  let lastLoggedStatus = "";

  while (Date.now() < deadlineMs) {
    await sleep(pollIntervalMs);

    let status: StatusResponse;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(statusUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        await onLog?.("stderr", `Status poll returned HTTP ${res.status}\n`);
        continue;
      }

      status = (await res.json()) as StatusResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog?.("stderr", `Status poll error: ${msg}\n`);
      continue;
    }

    // Log status transitions
    const statusKey = `${status.status}:${status.heartbeat?.possiblyActive ?? "?"}`;
    if (statusKey !== lastLoggedStatus) {
      await onLog?.(
        "stdout",
        `Cage status: ${status.status}, heartbeat active: ${status.heartbeat?.possiblyActive ?? "unknown"}\n`,
      );
      lastLoggedStatus = statusKey;
    }

    // Heartbeat completed: lastEnd is after our invoke time
    if (
      status.heartbeat &&
      !status.heartbeat.possiblyActive &&
      status.heartbeat.lastEnd != null &&
      status.heartbeat.lastEnd > invokeTime
    ) {
      return {
        completed: true,
        timedOut: false,
        cageStatus: status.status,
        summary: "Heartbeat completed",
      };
    }

    // Cage stopped or hibernating after we triggered — work is done
    if (
      !status.available &&
      (status.status === "stopped" || status.status === "hibernating")
    ) {
      return {
        completed: true,
        timedOut: false,
        cageStatus: status.status,
        summary: `Cage ${status.status} after heartbeat`,
      };
    }
  }

  return {
    completed: false,
    timedOut: true,
    cageStatus: "unknown",
    summary: "Timed out waiting for heartbeat completion",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
