# @paperclipai/adapter-lobstercage

A Paperclip adapter for [LobsterCage](https://lobstercage.ai) — sandboxed
Fargate containers that host AI agents. This adapter speaks LobsterCage's
typed `paperclip_runtime` contract (APT-710): Paperclip POSTs an APT-710
invoke envelope to the cage, the cage-side runtime drives a configured
runner (e.g. a Claude-backed issue solver) that calls back to Paperclip's
HTTP API for work, and returns a structured result.

```
Paperclip heartbeat
        │
        ▼
┌───────────────────┐    HTTPS       ┌────────────────┐   VPC   ┌────────────────┐
│ lobstercage       │ ─────────────▶ │ Gateway proxy  │ ──────▶ │ cage-manager   │
│ adapter (this pkg)│  POST /paperclip/run              port 8080│ + typed runtime │
│                   │ ◀───────────── │ (token auth)   │ ◀────── │ + runner       │
│                   │  GET  /paperclip/runs/:id                  └────┬───────────┘
└───────────────────┘                                                  │
                                                                       │ outbound
                                                       ┌───────────────┴───────────┐
                                                       ▼                           ▼
                                              Anthropic /v1/messages    Paperclip API
                                              (cage's key)              (cage's key)
```

## Single-purpose

This adapter speaks only the typed runtime contract. It does **not** build
wake-prompt text for managed OpenClaw workers, does not carry an auth
token in its config, and does not own any credentials. Everything the
runner inside the cage needs — the Anthropic API key, the Paperclip API
key, the model selection — lives in the cage's local
`paperclipRuntime.runnerConfig` per the APT-714 "credentials belong to
the runner, never to LobsterCage" principle.

## Configuration

```ts
{
  adapterType: "lobstercage",
  adapterConfig: {
    webhookUrl: string;          // required — https://{domain}/hook/{cageId}/{webhookToken}
    timeoutSec?: number;         // default 600 (also sent as envelope.execution.timeoutMs)
    pollIntervalSec?: number;    // default 2
  }
}
```

The `webhookToken` in the URL path is the cage's authentication secret;
LobsterCage's gateway proxy validates it via `timingSafeEqual` before
forwarding. No additional adapter-level auth is required.

## End-to-end flow

1. Paperclip's heartbeat dispatcher calls `execute(ctx)`.
2. The adapter builds an APT-710 v1 envelope from `ctx`: `run.runId`,
   `run.agentId`, `run.companyId`, `run.wakeReason`
   (defaults to `"paperclip_wake"`), `run.source: "paperclip"`,
   `task.kind` (`"issue_execution"` when a `taskId` is resolvable,
   else `"heartbeat"`), `task.taskId`,
   `task.checkedOutByHarness`, `execution.sessionPolicy`
   (`"fresh"` if `ctx.context.forceFreshSession === true`, else
   `"reuse"`), `execution.sessionKey`, `execution.timeoutMs`,
   `upstream: { type: "paperclip", baseUrl: PAPERCLIP_API_URL }`.
3. POST `{webhookUrl}/paperclip/run` with that envelope.
4. Receive `202 { accepted: true, runtimeRunId, status: "accepted", stream: { type: "none" } }` (the cage-side runtime lifecycle is `accepted → preparing → running → terminal`; any non-terminal status keeps the adapter polling).
5. Poll `{webhookUrl}/paperclip/runs/{runtimeRunId}` every
   `pollIntervalSec` until the response `status` is terminal
   (`completed` / `failed` / `blocked` / `cancelled`) or `timeoutSec`
   elapses.
6. Map the terminal response to `AdapterExecutionResult` via
   `mapRuntimeRunToResult`.

## Error code provenance

Error codes surfaced to Paperclip preserve their source:

| Prefix / code | Origin |
|---|---|
| `lobstercage_accept_failed` | adapter — cage returned non-202 on `/paperclip/run`, or the accept body was missing `runtimeRunId`, or the accept body failed to parse |
| `lobstercage_network_error` | adapter — fetch threw during the accept POST |
| `lobstercage_poll_failed` | adapter — permanent poll failure: the cage returned 4xx (auth revoked, run not found), or a 2xx with an unparseable JSON body (contract violation) |
| `lobstercage_timeout` | adapter — wall-clock poll deadline elapsed (includes sustained 5xx or network outages — 5xx/network poll failures are treated as transient and retried until this deadline) |
| `lobstercage_unexpected_runtime_result` | adapter — cage returned a terminal status with missing or malformed `result` envelope |
| `lobstercage_webhook_url_missing` / `lobstercage_webhook_url_format` / `lobstercage_webhook_url_valid` | adapter — `testEnvironment` config validation |
| `lobstercage_status_probe_ok` / `lobstercage_status_probe_failed` / `lobstercage_status_probe_error` | adapter — `testEnvironment` reachability probe outcome |
| `lobstercage_cage_unavailable` | adapter — `testEnvironment` probe returned 2xx but the cage reported `available: false` (stopped / hibernating / destroyed) |
| `runner_blocked`, `runner_cancelled`, `runner_not_implemented`, `runner_threw` | cage runtime — runner-side structured outcomes |
| `upstream_fetch_failed`, `finalization_failed` | cage runner — HTTP call back to Paperclip returned non-2xx |
| `solver_threw`, `claude_api_error` | cage runner — Anthropic API call failed (with `statusCode` metadata when available) |
| `cancel_requested`, `timeout` | cage runtime — abort-signal-driven cancellation or envelope `timeoutMs` elapsed |

Adapter-originated failures are prefixed `lobstercage_*`; everything else
is the runner's structured error code passed through verbatim so the
Paperclip UI can show where the problem originated.

## Trust boundary

- **Webhook token** in the URL path authenticates the request at the
  LobsterCage gateway proxy.
- **Gateway proxy → cage-manager**: proxy connects from outside the cage
  via the cage's VPC-internal IP (non-loopback) and injects
  `X-LobsterCage-Proxy: true`.
- **cage-manager**: `/paperclip/*` routes reject loopback-sourced
  requests and require the proxy header, so cage-local workloads cannot
  self-submit or self-cancel runtime jobs.

## What this adapter does **not** do

- Does not stream assistant/tool events — the cage-side runtime drives
  the runner; this adapter only transports the envelope and polls for the
  terminal result. `parseLobsterCageStdoutLine` renders the adapter's
  orchestration breadcrumbs as plain stdout entries.
- Does not wire up cancellation. When Paperclip's
  `AdapterExecutionContext` exposes an abort signal in a future version,
  the adapter will call `POST /paperclip/runs/:id/cancel` in response.
  Until then, Paperclip giving up waits for either the runtime's
  timeoutMs or the adapter's pollIntervalSec to land.
- Does not inject a Paperclip-issued JWT (`supportsLocalAgentJwt: false`).
  The runner inside the cage carries its own Paperclip API key from the
  cage's own runner config.
- Does not ship an instructions bundle
  (`supportsInstructionsBundle: false`).

## Tests

`pnpm exec vitest run` inside this package runs 31 unit tests covering
envelope construction, result mapping, HTTP flow, `testEnvironment`
probe, and UI config builder. No integration tests against a live cage
ship in this package; the LobsterCage repo owns cage-side integration
tests for the runtime + runners.

## Setup (end user)

1. Provision a LobsterCage cage via the `lobster` CLI or dashboard. The
   cage must have `paperclipRuntime.runnerType` set in its
   `.openclaw/openclaw.json` (e.g. `"claude_issue_execution"`) and its
   runner config must carry the cage's Anthropic and Paperclip API keys.
2. Copy the cage's webhook URL
   (`https://gateway.lobstercage.ai/hook/{cageId}/{token}`).
3. In Paperclip, create or edit an agent, select adapter type
   **LobsterCage**, paste the webhook URL. Save.
4. Trigger a wake. Verify the heartbeat run completes.

More detailed setup and runner authoring documentation lives in the
LobsterCage project: https://lobstercage.ai/docs.

## Follow-up items tracked outside this package

- Cancellation wire-up (pending Paperclip `AdapterExecutionContext`
  abort-signal surface)
- UI enhancements: runner-type picker that writes cage-side config;
  Anthropic/Paperclip key fields that propagate to the cage's runner
  config; deep-links to cage logs from heartbeat-run detail pages.
- Cost visibility: surface `claude_api_usage` artifact in Paperclip UI.
- "Provision new LobsterCage" one-click flow on the Add Agent form.
- Runner authoring guide + examples repo for third-party runners.
- Shared TypeScript types package for the envelope shape so adapter and
  cage parser don't drift.
