import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseWebhookUrl } from "./parse-webhook-url.js";
import { buildInvokeEnvelope } from "./build-envelope.js";
import { mapRuntimeRunToResult, type RuntimeRunStatusResponse } from "./map-result.js";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_POLL_INTERVAL_SEC = 2;
const ACCEPT_FETCH_TIMEOUT_MS = 30_000;
const POLL_FETCH_TIMEOUT_MS = 15_000;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const webhookUrl = asString(config.webhookUrl, "");
  if (!webhookUrl) {
    throw new Error("LobsterCage adapter requires webhookUrl in adapterConfig");
  }

  const timeoutSec = Math.max(1, asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC));
  const pollIntervalSec = Math.max(
    0.01,
    asNumber(config.pollIntervalSec, DEFAULT_POLL_INTERVAL_SEC),
  );
  const timeoutMs = Math.floor(timeoutSec * 1000);
  const pollIntervalMs = Math.max(10, Math.floor(pollIntervalSec * 1000));

  const { domain, cageId, webhookToken } = parseWebhookUrl(webhookUrl);
  const submitUrl = `${domain}/hook/${cageId}/${webhookToken}/paperclip/run`;
  const envelope = buildInvokeEnvelope(ctx);

  await ctx.onLog("stdout", `Submitting paperclip_runtime envelope to cage ${cageId}...\n`);

  let accepted: { runtimeRunId?: unknown } | null;
  try {
    const res = await fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }, ACCEPT_FETCH_TIMEOUT_MS);

    if (res.status !== 202) {
      const body = await res.text().catch(() => "");
      return acceptFailed(cageId, res.status, body);
    }

    accepted = (await res.json().catch(() => null)) as { runtimeRunId?: unknown } | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "lobstercage_network_error",
      errorMessage: `Failed to submit envelope to cage ${cageId}: ${msg}`,
    };
  }

  const runtimeRunId = asString(accepted?.runtimeRunId, "");
  if (!runtimeRunId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "lobstercage_accept_failed",
      errorMessage: `Cage ${cageId} accepted envelope without runtimeRunId`,
    };
  }

  await ctx.onLog(
    "stdout",
    `Accepted. runtimeRunId=${runtimeRunId}. Polling for completion...\n`,
  );

  const pollUrl = `${domain}/hook/${cageId}/${webhookToken}/paperclip/runs/${runtimeRunId}`;
  const deadlineMs = Date.now() + timeoutMs;

  while (Date.now() < deadlineMs) {
    try {
      const res = await fetchWithTimeout(pollUrl, { method: "GET" }, POLL_FETCH_TIMEOUT_MS);

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const snippet = bodyText.trim().length > 0 ? `: ${bodyText.slice(0, 256)}` : "";

        // 4xx: permanent. 401/404/409 etc. mean the run is gone or auth
        // is broken; there is no point continuing to poll. Surface the
        // real status so Paperclip's UI shows why, instead of masking it
        // as a late wall-clock timeout.
        if (res.status >= 400 && res.status < 500) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "lobstercage_poll_failed",
            errorMessage: `Polling runtime run ${runtimeRunId} on cage ${cageId} returned HTTP ${res.status}${snippet}`,
          };
        }

        // 5xx: transient. The gateway proxy returns 502 when it can't
        // temporarily forward to the cage (ECONNREFUSED, EHOSTUNREACH,
        // cage restart mid-poll) — see `proxy/src/index.ts` transient
        // forward-failure path. Keep polling; the cage-side runtime
        // often completes successfully despite brief reachability blips.
        // A sustained outage still surfaces as `lobstercage_timeout`
        // when the wall-clock deadline elapses.
        await ctx.onLog(
          "stderr",
          `poll transient failure: HTTP ${res.status}${snippet}\n`,
        );
      } else {
        const body = (await res.json().catch(() => null)) as RuntimeRunStatusResponse | null;

        // Malformed JSON on a 2xx response is a contract violation — the
        // cage-manager should always return a valid status envelope.
        // Fail fast rather than spin.
        if (body === null) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "lobstercage_poll_failed",
            errorMessage: `Polling runtime run ${runtimeRunId} on cage ${cageId} returned an unparseable JSON body`,
          };
        }

        if (typeof body.status === "string" && TERMINAL_STATUSES.has(body.status)) {
          await ctx.onLog(
            "stdout",
            `Runtime run ${runtimeRunId} terminated with status=${body.status}\n`,
          );
          return mapRuntimeRunToResult(body);
        }

        // Non-terminal 2xx (accepted / preparing / running) — keep polling.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Network-level failure (fetch threw, abort, ECONNREFUSED, etc.).
      // Treat the same way as a 5xx — transient; log and retry.
      // Sustained outages still hit the wall-clock `lobstercage_timeout`.
      await ctx.onLog("stderr", `poll error: ${msg}\n`);
    }

    await sleep(pollIntervalMs);
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: true,
    errorCode: "lobstercage_timeout",
    errorMessage: `Runtime run did not terminate within ${timeoutSec}s`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function acceptFailed(cageId: string, status: number, body: string): AdapterExecutionResult {
  const snippet = body.trim().length > 0 ? `: ${body.slice(0, 256)}` : "";
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "lobstercage_accept_failed",
    errorMessage: `Cage ${cageId} rejected envelope with HTTP ${status}${snippet}`,
  };
}
