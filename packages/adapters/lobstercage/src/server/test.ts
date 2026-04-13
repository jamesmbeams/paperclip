import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const webhookUrl = asString(config.webhookUrl, "");
  const openclawAuthToken = asString(config.openclawAuthToken, "");

  if (!webhookUrl) {
    checks.push({
      code: "lobstercage_webhook_url_missing",
      level: "error",
      message: "LobsterCage adapter requires webhookUrl.",
      hint: "Set adapterConfig.webhookUrl to the cage's webhook URL from the LobsterCage dashboard.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Validate URL format
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    checks.push({
      code: "lobstercage_webhook_url_invalid",
      level: "error",
      message: "Invalid webhook URL format.",
      hint: "Ensure the URL is a valid https:// URL from the LobsterCage dashboard.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "hook") {
    checks.push({
      code: "lobstercage_webhook_url_format",
      level: "error",
      message:
        "Webhook URL does not match expected format: https://{domain}/hook/{cageId}/{webhookToken}",
      hint: "Copy the full webhook URL from the LobsterCage dashboard.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const cageId = segments[1];
  const webhookToken = segments[2];

  checks.push({
    code: "lobstercage_webhook_url_valid",
    level: "info",
    message: `Webhook URL is valid (cage: ${cageId})`,
  });

  if (!openclawAuthToken) {
    checks.push({
      code: "lobstercage_openclaw_auth_token_missing",
      level: "warn",
      message:
        "openclawAuthToken is not configured. Current OpenClaw hooks usually require a dedicated hook token.",
      hint:
        "Set adapterConfig.openclawAuthToken to the hook token configured in the cage's ~/.openclaw/openclaw.json hooks.token field.",
    });
  }

  // Probe the status endpoint
  const statusUrl = `${parsed.origin}/status/${cageId}/${webhookToken}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(statusUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      checks.push({
        code: "lobstercage_status_probe_failed",
        level: "warn",
        message: `Status endpoint returned HTTP ${res.status}`,
        hint: "Verify the cage exists and the webhook token is correct.",
      });
    } else {
      const body = (await res.json()) as Record<string, unknown>;
      const cageStatus = typeof body.status === "string" ? body.status : "unknown";
      const available = body.available === true;

      checks.push({
        code: "lobstercage_status_probe_ok",
        level: "info",
        message: `Cage is reachable (status: ${cageStatus}, available: ${available})`,
      });

      if (cageStatus === "destroyed") {
        checks.push({
          code: "lobstercage_cage_destroyed",
          level: "error",
          message: "Cage has been destroyed. Create a new cage or update the webhook URL.",
        });
      }
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "lobstercage_status_probe_error",
      level: "warn",
      message: `Could not reach status endpoint: ${msg}`,
      hint: "This may be expected if the Paperclip server cannot reach LobsterCage's gateway. Verify network connectivity.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
