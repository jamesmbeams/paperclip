import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execute } from "./execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeCtx(
  configOverrides: Record<string, unknown> = {},
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
      timeoutSec: 10,
      pollIntervalSec: 0.1,
      ...configOverrides,
    },
    context: {},
    onLog: vi.fn(),
  };
}

describe("execute", () => {
  it("throws if webhookUrl is missing", async () => {
    const ctx = makeCtx({ webhookUrl: "" });
    await expect(execute(ctx)).rejects.toThrow("requires webhookUrl");
  });

  it("returns error on trigger failure (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_trigger_failed");
    expect(result.errorMessage).toContain("connection refused");
  });

  it("does not leak webhook token in trigger error messages", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));

    const result = await execute(makeCtx());

    expect(result.errorMessage).not.toContain("tok123");
  });

  it("returns error on unexpected trigger status", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_trigger_unexpected_status");
    expect(result.errorMessage).not.toContain("tok123");
  });

  it("succeeds when trigger returns 200 and heartbeat completes", async () => {
    const now = Date.now();
    // Trigger: cage was running, forwarded
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    // Poll 1: heartbeat active
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: true,
          lastStart: now + 50,
          lastEnd: null,
        },
      }),
    );
    // Poll 2: heartbeat done
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: now + 50,
          lastEnd: now + 200,
        },
      }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("Heartbeat completed");
  });

  it("succeeds when trigger returns 202 and cage stops after heartbeat ran", async () => {
    const now = Date.now();
    // Trigger: cage was stopped, now waking
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "waking" }, 202),
    );
    // Poll 1: heartbeat active
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: now + 100, lastEnd: null },
      }),
    );
    // Poll 2: cage stopped after work
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: now + 100, lastEnd: null },
      }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("fails when cage stops without heartbeat evidence (wake failed)", async () => {
    // Trigger accepted
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 202));
    // Poll: cage stopped but no heartbeat ran
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: null, lastEnd: null },
      }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_wake_failed");
  });

  it("fails immediately when cage is destroyed mid-run", async () => {
    // Trigger accepted
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    // Poll: cage destroyed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ available: false, status: "destroyed" }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_cage_destroyed");
  });

  it("includes auth header when openclawAuthToken is provided", async () => {
    const now = Date.now();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: now + 50, lastEnd: null },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: now + 50, lastEnd: null },
      }),
    );

    await execute(makeCtx({ openclawAuthToken: "secret-token" }));

    const triggerCall = mockFetch.mock.calls[0];
    const requestInit = triggerCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
  });

  it("returns timeout result when polling exceeds deadline", async () => {
    const now = Date.now();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    // Always return active heartbeat
    mockFetch.mockResolvedValue(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: now + 50, lastEnd: null },
      }),
    );

    const result = await execute(
      makeCtx({ timeoutSec: 0.3, pollIntervalSec: 0.1 }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("lobstercage_timeout");
  });

  it("constructs correct webhook trigger URL from webhookUrl", async () => {
    const now = Date.now();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: now + 50, lastEnd: null },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: now + 50, lastEnd: null },
      }),
    );

    await execute(makeCtx());

    const triggerUrl = mockFetch.mock.calls[0][0] as string;
    expect(triggerUrl).toBe(
      "https://gateway.lobstercage.ai/hook/cage_abc/tok123/hooks/wake",
    );
  });
});
