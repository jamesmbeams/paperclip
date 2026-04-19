import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * APT-710 typed invoke envelope produced by the LobsterCage adapter.
 *
 * Every field on this shape is validated by the cage-side runtime
 * (`sandbox/paperclip-runtime.mjs:parsePaperclipInvokeEnvelope`). In
 * particular `run.wakeReason` and `run.source` are non-optional: an
 * envelope with either empty will be rejected at accept time with a 400.
 * The adapter therefore hard-codes `run.source = "paperclip"` and
 * substitutes a safe `"paperclip_wake"` default if `ctx.context.wakeReason`
 * is absent — Paperclip's normalized wake payload can return `reason: null`
 * even when a wake really did happen (see
 * `packages/adapter-utils/src/server-utils.ts:normalizePaperclipWakePayload`).
 */
export interface LobsterCageInvokeEnvelope {
  version: "v1";
  run: {
    runId: string;
    agentId: string;
    companyId: string;
    wakeReason: string;
    source: "paperclip";
  };
  task: {
    kind: "issue_execution" | "heartbeat";
    taskId: string | null;
    checkedOutByHarness: boolean;
  };
  execution: {
    sessionPolicy: "fresh" | "reuse";
    sessionKey: string;
    timeoutMs: number;
  };
  upstream: {
    type: "paperclip";
    baseUrl: string;
  };
}

const DEFAULT_WAKE_REASON = "paperclip_wake";
const DEFAULT_TIMEOUT_SEC = 600;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildInvokeEnvelope(
  ctx: AdapterExecutionContext,
): LobsterCageInvokeEnvelope {
  const config = parseObject(ctx.config);
  const context = parseObject(ctx.context);

  const taskId =
    nonEmptyString(context.taskId) ?? nonEmptyString(context.issueId);
  const kind: "issue_execution" | "heartbeat" =
    taskId !== null ? "issue_execution" : "heartbeat";

  const sessionPolicy: "fresh" | "reuse" =
    context.forceFreshSession === true ? "fresh" : "reuse";

  const sessionKey =
    kind === "issue_execution"
      ? `agent:${ctx.agent.id}:issue:${taskId}`
      : `agent:${ctx.agent.id}:heartbeat`;

  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutMs = Math.max(1, Math.floor(timeoutSec * 1000));

  const wakeReason =
    nonEmptyString(context.wakeReason) ?? DEFAULT_WAKE_REASON;

  const paperclipEnv = buildPaperclipEnv(ctx.agent);
  const baseUrl = paperclipEnv.PAPERCLIP_API_URL;

  return {
    version: "v1",
    run: {
      runId: ctx.runId,
      agentId: ctx.agent.id,
      companyId: ctx.agent.companyId,
      wakeReason,
      source: "paperclip",
    },
    task: {
      kind,
      taskId: taskId,
      checkedOutByHarness: context.checkedOutByHarness === true,
    },
    execution: {
      sessionPolicy,
      sessionKey,
      timeoutMs,
    },
    upstream: {
      type: "paperclip",
      baseUrl,
    },
  };
}
