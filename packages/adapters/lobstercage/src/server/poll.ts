/**
 * Poll the LobsterCage status endpoint until the heartbeat completes,
 * the cage is destroyed, or the deadline is exceeded.
 *
 * Completion requires positive evidence that *this* invocation's heartbeat
 * ran: we must observe lastStart >= invokeTime (our trigger caused it)
 * and then lastEnd > lastStart (it finished). A bare "stopped" cage with
 * no heartbeat evidence is treated as a failed wake, not a success.
 */

export interface PollResult {
  completed: boolean;
  timedOut: boolean;
  failed: boolean;
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
  let sawHeartbeatActive = false;

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

    // Cage destroyed — terminal failure, stop immediately
    if (status.status === "destroyed") {
      return {
        completed: false,
        timedOut: false,
        failed: true,
        cageStatus: "destroyed",
        summary: "Cage was destroyed during heartbeat",
      };
    }

    // Track whether we've ever seen the heartbeat active for this invocation.
    // This guards against false positives from stale or concurrent heartbeats.
    if (
      status.heartbeat?.possiblyActive &&
      status.heartbeat.lastStart != null &&
      status.heartbeat.lastStart >= invokeTime
    ) {
      sawHeartbeatActive = true;
    }

    // Heartbeat completed: we saw it start after our invoke, and it finished.
    // Requires lastStart >= invokeTime (our trigger) AND lastEnd > lastStart.
    if (
      sawHeartbeatActive &&
      status.heartbeat &&
      !status.heartbeat.possiblyActive &&
      status.heartbeat.lastStart != null &&
      status.heartbeat.lastStart >= invokeTime &&
      status.heartbeat.lastEnd != null &&
      status.heartbeat.lastEnd > status.heartbeat.lastStart
    ) {
      return {
        completed: true,
        timedOut: false,
        failed: false,
        cageStatus: status.status,
        summary: "Heartbeat completed",
      };
    }

    // Cage stopped/hibernating AFTER we observed the heartbeat running —
    // the work ran and the cage shut down naturally.
    if (
      sawHeartbeatActive &&
      !status.available &&
      (status.status === "stopped" || status.status === "hibernating")
    ) {
      return {
        completed: true,
        timedOut: false,
        failed: false,
        cageStatus: status.status,
        summary: `Cage ${status.status} after heartbeat`,
      };
    }

    // Cage stopped/hibernating but we never saw a heartbeat for this invoke —
    // the wake failed or the cage stopped for another reason.
    if (
      !sawHeartbeatActive &&
      !status.available &&
      (status.status === "stopped" || status.status === "hibernating")
    ) {
      return {
        completed: false,
        timedOut: false,
        failed: true,
        cageStatus: status.status,
        summary: `Cage ${status.status} without running heartbeat — wake may have failed`,
      };
    }
  }

  return {
    completed: false,
    timedOut: true,
    failed: false,
    cageStatus: "unknown",
    summary: "Timed out waiting for heartbeat completion",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
