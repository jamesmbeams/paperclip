import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/**
 * Produce the lobstercage `adapterConfig` object from UI form values.
 *
 * The adapter's config surface is intentionally tiny (see the package
 * `agentConfigurationDoc`): `webhookUrl` is the only required field.
 * Auth lives inside the webhook token embedded in the URL path; no
 * adapter-level auth token.
 */
export function buildLobsterCageConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {
    timeoutSec: 600,
    pollIntervalSec: 2,
  };
  if (v.url) ac.webhookUrl = v.url;
  return ac;
}
