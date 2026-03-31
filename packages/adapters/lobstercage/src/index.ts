export const type = "lobstercage";
export const label = "LobsterCage";

// LobsterCage is runtime-agnostic — the cage runs whatever agent is configured inside it.
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# lobstercage agent configuration

Adapter: lobstercage

Runs agents in isolated LobsterCage containers with hibernate/wake lifecycle.
The cage wakes on each heartbeat, executes the agent's work, then hibernates
when idle — you pay only for active compute.

Prerequisites:
- A LobsterCage account with a running or stopped cage
- The cage must have OpenClaw configured with heartbeat enabled
- Paperclip env vars set on the cage (PAPERCLIP_API_URL, PAPERCLIP_API_KEY, etc.)

Core fields:
- webhookUrl (string, required): full webhook URL from LobsterCage dashboard (https://{domain}/hook/{cageId}/{token})
- openclawAuthToken (string, optional): OpenClaw gateway auth token for triggering heartbeats
- timeoutSec (number, optional): max seconds to wait for heartbeat completion (default 600)
- pollIntervalSec (number, optional): seconds between status polls (default 5)

Notes:
- The agent discovers work via the Paperclip API using PAPERCLIP_API_KEY
- EFS-backed storage persists across hibernate cycles
- Idle timeout on the cage controls when it hibernates after work completes
`;
