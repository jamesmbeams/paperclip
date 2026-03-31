import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildLobsterCageConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.webhookUrl = v.url;
  ac.timeoutSec = 600;
  ac.pollIntervalSec = 5;
  return ac;
}
