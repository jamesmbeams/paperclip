/**
 * Parse a LobsterCage webhook URL into its addressable parts.
 *
 * Expected shape: `https://{domain}/hook/{cageId}/{webhookToken}` with an
 * optional trailing subpath that we ignore. The webhook token is the
 * cage's authentication secret; the gateway proxy validates it before
 * forwarding to cage-manager.
 */
export interface ParsedWebhookUrl {
  domain: string;
  cageId: string;
  webhookToken: string;
}

export function parseWebhookUrl(raw: string): ParsedWebhookUrl {
  const url = new URL(raw);
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
