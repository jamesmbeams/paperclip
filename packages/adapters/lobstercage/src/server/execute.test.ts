import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", mockFetch);
  process.env.PAPERCLIP_API_URL = "https://paperclip.example.com";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.PAPERCLIP_API_URL;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeCtx(
  configOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-1",
      companyId: "co-1",
      name: "Test Agent",
      adapterType: "lobstercage",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok123",
      timeoutSec: 30,
      pollIntervalSec: 0.1,
      ...configOverrides,
    },
    context: {
      taskId: "issue-abc",
      wakeReason: "issue_assigned",
      ...contextOverrides,
    },
    onLog: vi.fn(),
  };
}

describe("execute — paperclip_runtime", () => {
  it("happy path: accept 202 → one running poll → one completed poll → returns exitCode 0 with summary; POST body matches envelope shape", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        { accepted: true, runtimeRunId: "rt-1", status: "accepted", stream: { type: "none" } },
        202,
      ),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "running", result: null }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "completed",
        result: {
          status: "completed",
          outcome: { summary: "done!", comment: "lgtm" },
          error: null,
        },
      }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done!");

    const submitUrl = mockFetch.mock.calls[0][0] as string;
    expect(submitUrl).toBe(
      "https://gateway.lobstercage.ai/hook/cage_abc/tok123/paperclip/run",
    );

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const envelope = JSON.parse(String(init.body));
    expect(envelope).toMatchObject({
      version: "v1",
      run: {
        runId: "run-123",
        agentId: "agent-1",
        companyId: "co-1",
        wakeReason: "issue_assigned",
        source: "paperclip",
      },
      task: { kind: "issue_execution", taskId: "issue-abc", checkedOutByHarness: false },
      execution: {
        sessionKey: "agent:agent-1:issue:issue-abc",
        timeoutMs: 30_000,
      },
      upstream: { type: "paperclip", baseUrl: "https://paperclip.example.com" },
    });

    // Poll URLs: /hook/.../paperclip/runs/rt-1
    const pollUrl = mockFetch.mock.calls[1][0] as string;
    expect(pollUrl).toBe(
      "https://gateway.lobstercage.ai/hook/cage_abc/tok123/paperclip/runs/rt-1",
    );
  });

  it("returns lobstercage_accept_failed when the accept POST returns a non-202", async () => {
    mockFetch.mockResolvedValueOnce(new Response("bad envelope", { status: 400 }));
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_accept_failed");
    expect(result.errorMessage).toContain("400");
  });

  it("returns lobstercage_network_error when the accept fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_network_error");
    expect(result.errorMessage).toContain("ECONNREFUSED");
  });

  it("returns lobstercage_accept_failed when the accept body is missing runtimeRunId", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, status: "accepted", stream: { type: "none" } }, 202),
    );
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_accept_failed");
  });

  it("passes runner error codes through verbatim on terminal failed runs (upstream_fetch_failed)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-2", stream: { type: "none" } }, 202),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "failed",
        result: {
          status: "failed",
          error: { code: "upstream_fetch_failed", message: "issue not found" },
        },
      }),
    );
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("upstream_fetch_failed");
    expect(result.errorMessage).toBe("issue not found");
  });

  it("surfaces runner_blocked with outcome.comment as errorMessage when terminal blocked is returned", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-3", stream: { type: "none" } }, 202),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "blocked",
        result: {
          status: "blocked",
          outcome: { summary: "needs_clarification", comment: "please clarify acceptance criteria" },
          error: null,
        },
      }),
    );
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("runner_blocked");
    expect(result.errorMessage).toBe("please clarify acceptance criteria");
  });

  it("returns lobstercage_timeout when polling exceeds timeoutSec deadline", async () => {
    // Using mockImplementation (not mockResolvedValue) so each fetch call
    // receives a freshly-constructed Response — Response bodies are
    // single-use streams and a single shared instance would be consumed
    // on the first poll and fail to parse on subsequent polls.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-4", stream: { type: "none" } }, 202),
    );
    mockFetch.mockImplementation(async () =>
      jsonResponse({ status: "running", result: null }),
    );

    const result = await execute(makeCtx({ timeoutSec: 0.2, pollIntervalSec: 0.05 }));
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("lobstercage_timeout");
  });

  it("treats a 202 accept body that fails JSON parse as lobstercage_accept_failed", async () => {
    // The cage-manager always returns JSON on a valid 202, but a gateway
    // hiccup (truncated response, wrong content-type, byte corruption) could
    // hand the adapter bytes that don't parse. Verify we degrade cleanly.
    mockFetch.mockResolvedValueOnce(
      new Response("not-json{{{", {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_accept_failed");
  });

  it("fails fast with lobstercage_poll_failed when a poll returns unparseable JSON on a 2xx response", async () => {
    // An empty body (or other malformed JSON) on a 2xx poll is a
    // contract violation from the cage-manager. Surface it immediately
    // instead of spinning to a misleading `lobstercage_timeout`.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-empty", stream: { type: "none" } }, 202),
    );
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await execute(makeCtx({ pollIntervalSec: 0.01, timeoutSec: 10 }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_poll_failed");
    expect(result.timedOut).toBe(false);
  });

  it("fails fast with lobstercage_poll_failed when a poll returns a 4xx response (permanent)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-401", stream: { type: "none" } }, 202),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_poll_failed");
    expect(result.errorMessage).toContain("401");
  });

  it("treats a 5xx poll as transient — keeps polling and recovers when the cage becomes reachable again", async () => {
    // The LobsterCage gateway returns 502 on transient forward failures
    // (ECONNREFUSED / EHOSTUNREACH during cage restart or brief network
    // blips). Treating these as permanent would fail an otherwise-healthy
    // run; we retry and let the wall-clock timeout catch sustained
    // outages instead.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-502", stream: { type: "none" } }, 202),
    );
    // Poll 1: gateway-level 502 blip
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Failed to reach cage" }), { status: 502 }),
    );
    // Poll 2: cage reachable again, terminal
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "completed",
        result: { status: "completed", outcome: { summary: "ok" }, error: null },
      }),
    );

    const result = await execute(makeCtx({ pollIntervalSec: 0.01, timeoutSec: 10 }));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("ok");
  });

  it("surfaces lobstercage_timeout (not lobstercage_poll_failed) when 5xx persists past the wall-clock deadline", async () => {
    // Sustained 5xx still ends in a wall-clock timeout so the operator
    // has an upper bound on how long the adapter will hold the run open.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-500-persist", stream: { type: "none" } }, 202),
    );
    mockFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );

    const result = await execute(makeCtx({ timeoutSec: 0.2, pollIntervalSec: 0.05 }));
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("lobstercage_timeout");
  });

  it("clamps a zero/negative pollIntervalSec to a safe minimum and still terminates", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-clamp", stream: { type: "none" } }, 202),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "completed",
        result: { status: "completed", outcome: { summary: "ok" }, error: null },
      }),
    );

    // A misconfigured cage setting pollIntervalSec to 0 or negative must
    // not cause a hot loop; the adapter clamps to a safe minimum.
    const result = await execute(makeCtx({ pollIntervalSec: 0, timeoutSec: 10 }));
    expect(result.exitCode).toBe(0);
  });

  it("tolerates transient poll network errors and succeeds on subsequent poll", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ accepted: true, runtimeRunId: "rt-5", stream: { type: "none" } }, 202),
    );
    // Poll 1: throws
    mockFetch.mockRejectedValueOnce(new Error("connection reset"));
    // Poll 2: running
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "running", result: null }));
    // Poll 3: completed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "completed",
        result: { status: "completed", outcome: { summary: "ok" }, error: null },
      }),
    );

    const result = await execute(makeCtx({ pollIntervalSec: 0.01, timeoutSec: 10 }));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("ok");
  });
});
