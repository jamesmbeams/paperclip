export const type = "lobstercage";
export const label = "LobsterCage";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# lobstercage agent configuration

Adapter: lobstercage

Use when:
- You run your agent inside a LobsterCage sandboxed container and want Paperclip
  to invoke it through the typed \`paperclip_runtime\` contract.

Don't use when:
- Your cage does not have a \`paperclipRuntime.runnerType\` configured. Without
  a configured runner the cage returns \`runner_not_implemented\` on every wake.
- You want prompt-based OpenClaw integration. That path is not supported by
  this adapter.

Core fields:
- webhookUrl (string, required): full LobsterCage webhook URL. Format:
  \`https://{domain}/hook/{cageId}/{webhookToken}\`. The gateway proxy uses
  this URL to route invokes + status polls to the cage's cage-manager
  service and injects the \`X-LobsterCage-Proxy\` trust-boundary header.

Timing fields:
- timeoutSec (number, optional): wall-clock deadline (seconds) for the adapter
  to wait for a runtime run to finish. Also sent as \`execution.timeoutMs\`
  on the invoke envelope so the cage-side runner honours the same budget.
  Default 600.
- pollIntervalSec (number, optional): interval between \`GET /paperclip/runs/:id\`
  polls. Default 2.

How it works:
- Adapter builds an APT-710 invoke envelope from \`ctx\` + adapter config.
- POSTs to \`{webhookUrl}/paperclip/run\`. Cage-manager accepts with
  \`{ accepted, runtimeRunId, status: "accepted", stream: { type: "none" } }\`
  (cage-side lifecycle: \`accepted → preparing → running → terminal\`).
- Adapter polls \`{webhookUrl}/paperclip/runs/{runtimeRunId}\` every
  \`pollIntervalSec\` until the response status is \`completed\`, \`failed\`,
  \`blocked\`, or \`cancelled\`. Adapter-owned error codes (prefixed
  \`lobstercage_*\`) distinguish accept failures, network errors, permanent
  poll failures (4xx), contract violations (malformed JSON on 2xx), and
  the wall-clock \`lobstercage_timeout\` that catches sustained 5xx or
  cage unresponsiveness. Runner-owned failures surface the runner's
  structured \`error.code\` verbatim (\`upstream_fetch_failed\`,
  \`solver_threw\`, \`runner_blocked\`, etc.) so Paperclip's UI shows where
  the problem originated.

Auth model:
- The webhook token (baked into the URL path) authenticates the request to
  the specific cage. The gateway proxy sits outside the cage and adds the
  \`X-LobsterCage-Proxy: true\` header when forwarding to cage-manager.
  No additional adapter-level auth token is needed.
- Credentials that the runner inside the cage needs (e.g. Anthropic API key
  for a Claude-backed runner) live in the cage's own runtime config, never
  in adapter config.

Further reading:
- LobsterCage project & docs: https://lobstercage.ai
- CLI (\`lobster\`): https://lobstercage.ai/docs/cli — provisions cages,
  configures \`paperclipRuntime.runnerType\`, manages env vars.
- Typed runtime contract reference (APT-710): shared between this adapter
  and the cage-manager implementation. The cage-side parser is the source
  of truth for envelope shape.
`;
