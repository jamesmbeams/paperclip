import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  buildPaperclipEnv,
  parseObject,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { pollForCompletion } from "./poll.js";

type WakePayload = {
  runId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { context, runId } = ctx;
  return {
    runId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

function buildPaperclipEnvForWake(
  ctx: AdapterExecutionContext,
  wakePayload: WakePayload,
): Record<string, string> {
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };

  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  return paperclipEnv;
}

function buildWakeText(
  payload: WakePayload,
  paperclipEnv: Record<string, string>,
  structuredWakePrompt: string,
): string {
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];

  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (!value) continue;
    envLines.push(`${key}=${value}`);
  }

  const issueIdHint = payload.taskId ?? payload.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL ?? "<set PAPERCLIP_API_URL>";

  const lines = [
    "Paperclip wake event for a LobsterCage worker.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs.",
    "",
    "These values are already available in the worker environment:",
    ...envLines,
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "- Use only /api endpoints listed below.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - POST /api/issues/{issueId}/checkout with {\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\",\"in_review\"]}",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments with {\"body\":\"...\"}.",
    "   - PATCH /api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"}.",
    "4) If issueId does not exist:",
    "   - GET /api/agents/me/inbox-lite",
    "   - If inbox is empty, reply HEARTBEAT_OK.",
    "   - Otherwise pick in_progress first, then in_review when woken by a comment, then todo, then blocked, then execute step 3.",
    "",
    "Useful endpoints for issue work:",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
    "- POST /api/companies/{companyId}/issues (when asked to create a new issue)",
    ...(structuredWakePrompt ? ["", structuredWakePrompt] : []),
    "",
    "Complete the workflow in this run.",
  ];

  return lines.join("\n");
}

function joinWakePayloadSections(
  structuredWakePrompt: string,
  structuredWakeJson: string,
): string {
  const sections = [
    structuredWakePrompt.trim(),
    "Structured wake payload JSON:",
    "```json",
    structuredWakeJson,
    "```",
  ].filter((entry) => entry.trim().length > 0);
  return sections.join("\n");
}

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
  const wakePayload = buildWakePayload(ctx);
  const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload);
  const structuredWakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const structuredWakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const wakeText = buildWakeText(
    wakePayload,
    paperclipEnv,
    structuredWakeJson
      ? joinWakePayloadSections(structuredWakePrompt, structuredWakeJson)
      : structuredWakePrompt,
  );

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
    const requestBody = JSON.stringify({
      text: wakeText,
      mode: "now",
    });
    const res = await fetch(triggerUrl, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    clearTimeout(timer);
    triggerStatus = res.status;
    if (triggerStatus !== 200 && triggerStatus !== 202) {
      const triggerBody = await res.text().catch(() => "");
      if (triggerBody.trim().length > 0) {
        await ctx.onLog("stderr", `Trigger response body: ${triggerBody}\n`);
      }
    }
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
