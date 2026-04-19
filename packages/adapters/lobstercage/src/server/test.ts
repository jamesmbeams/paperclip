import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseWebhookUrl } from "./parse-webhook-url.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

const PROBE_TIMEOUT_MS = 15_000;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const webhookUrl = asString(config.webhookUrl, "");
  const checks: AdapterEnvironmentCheck[] = [];

  if (!webhookUrl) {
    checks.push({
      code: "lobstercage_webhook_url_missing",
      level: "error",
      message: "adapterConfig.webhookUrl is required",
      hint: "Provision a cage in LobsterCage to get a https://{domain}/hook/{cageId}/{token} URL",
    });
    return finalize(ctx, checks);
  }

  let parsed;
  try {
    parsed = parseWebhookUrl(webhookUrl);
  } catch (err) {
    checks.push({
      code: "lobstercage_webhook_url_format",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return finalize(ctx, checks);
  }

  checks.push({
    code: "lobstercage_webhook_url_valid",
    level: "info",
    message: "Webhook URL parsed successfully",
    detail: `cage=${parsed.cageId}`,
  });

  const statusUrl = `${parsed.domain}/status/${parsed.cageId}/${parsed.webhookToken}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(statusUrl, { method: "GET", signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      checks.push({
        code: "lobstercage_status_probe_failed",
        level: "error",
        message: `Cage status endpoint returned HTTP ${res.status}`,
      });
      return finalize(ctx, checks);
    }

    // The LobsterCage gateway returns 200 with `{ available: false, status }`
    // for stopped/hibernating/unreachable cages, so `res.ok` alone doesn't
    // mean the cage is actually reachable for a wake. Parse the body and
    // warn when the cage isn't in a ready state.
    const parsed = await res.json().catch(() => null);
    const available = typeof parsed === "object" && parsed !== null
      && (parsed as Record<string, unknown>).available === true;
    const cageStatus =
      typeof parsed === "object" && parsed !== null
        && typeof (parsed as Record<string, unknown>).status === "string"
        ? String((parsed as Record<string, unknown>).status)
        : null;

    if (available) {
      checks.push({
        code: "lobstercage_status_probe_ok",
        level: "info",
        message: `Cage is reachable (status=${cageStatus ?? "unknown"})`,
        detail:
          "Reachability only — this does not verify that the cage has a paperclipRuntime runner configured. A missing runner will surface as runner_not_implemented on the first wake.",
      });
    } else {
      checks.push({
        code: "lobstercage_cage_unavailable",
        level: "warn",
        message: `Cage is currently unavailable (status=${cageStatus ?? "unknown"}). A wake attempt may cold-start it, but verify the cage exists and isn't in a failed state.`,
        hint:
          "Stopped/hibernating cages typically wake on first request; 'destroyed' or 'failed' cages need operator intervention in LobsterCage.",
      });
    }
  } catch (err) {
    checks.push({
      code: "lobstercage_status_probe_error",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
      hint: "Verify the webhook URL's domain and cageId are reachable from the Paperclip server",
    });
  }

  return finalize(ctx, checks);
}

function finalize(
  ctx: AdapterEnvironmentTestContext,
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult {
  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
