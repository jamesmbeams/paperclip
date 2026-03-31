import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { pollForCompletion } from "./poll.js";

/**
 * Parse the webhook URL to extract domain, cageId, and token.
 * Expected format: https://{domain}/hook/{cageId}/{webhookToken}
 * Optionally with a trailing subpath.
 */
function parseWebhookUrl(raw: string): {
  domain: string;
  cageId: string;
  webhookToken: string;
} {
  const url = new URL(raw);
  // pathname: /hook/{cageId}/{webhookToken}[/{...}]
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "hook") {
    throw new Error(
      "Invalid LobsterCage webhook URL: expected https://{domain}/hook/{cageId}/{webhookToken}",
    );
  }
  return {
    domain: url.origin,
    cageId: segments[1],
    webhookToken: segments[2],
  };
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const webhookUrl = asString(config.webhookUrl, "");
  if (!webhookUrl) {
    throw new Error("LobsterCage adapter requires webhookUrl in adapterConfig");
  }

  const openclawAuthToken = asString(config.openclawAuthToken, "");
  const timeoutSec = asNumber(config.timeoutSec, 600);
  const pollIntervalSec = asNumber(config.pollIntervalSec, 5);

  const { domain, cageId, webhookToken } = parseWebhookUrl(webhookUrl);
  const invokeTime = Date.now();

  // 1. Trigger heartbeat via the webhook gateway
  //    POST /hook/{cageId}/{token}/hooks/wake triggers OpenClaw's heartbeat
  const triggerUrl = `${domain}/hook/${cageId}/${webhookToken}/hooks/wake`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (openclawAuthToken) {
    headers["authorization"] = `Bearer ${openclawAuthToken}`;
  }

  await ctx.onLog("stdout", `Triggering heartbeat on cage ${cageId}...\n`);

  let triggerStatus: number;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(triggerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "now" }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    triggerStatus = res.status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to trigger heartbeat on cage ${cageId}: ${msg}`,
      errorCode: "lobstercage_trigger_failed",
    };
  }

  await ctx.onLog(
    "stdout",
    `Heartbeat trigger returned HTTP ${triggerStatus}\n`,
  );

  // 200 = cage was running, request forwarded
  // 202 = cage was stopped, now waking
  // Both are success cases
  if (triggerStatus !== 200 && triggerStatus !== 202) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Heartbeat trigger on cage ${cageId} returned unexpected HTTP ${triggerStatus}`,
      errorCode: "lobstercage_trigger_unexpected_status",
    };
  }

  // 2. Poll for heartbeat completion
  const statusUrl = `${domain}/status/${cageId}/${webhookToken}`;
  const deadlineMs = invokeTime + timeoutSec * 1000;
  const pollIntervalMs = pollIntervalSec * 1000;

  await ctx.onLog("stdout", "Waiting for heartbeat completion...\n");

  const result = await pollForCompletion(
    statusUrl,
    invokeTime,
    deadlineMs,
    pollIntervalMs,
    ctx.onLog,
  );

  await ctx.onLog(
    "stdout",
    `${result.summary} (cage: ${result.cageStatus})\n`,
  );

  if (result.completed) {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: result.summary,
    };
  }

  if (result.failed) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: result.summary,
      errorCode: `lobstercage_${result.cageStatus === "destroyed" ? "cage_destroyed" : "wake_failed"}`,
    };
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: true,
    errorMessage: result.summary,
    errorCode: "lobstercage_timeout",
  };
}
