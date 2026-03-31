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

  it("returns error on unexpected trigger status", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("lobstercage_trigger_unexpected_status");
  });

  it("succeeds when trigger returns 200 and heartbeat completes", async () => {
    // Trigger: cage was running, forwarded
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    // Poll: heartbeat done
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: Date.now() + 50,
          lastEnd: Date.now() + 100,
        },
      }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("Heartbeat completed");
  });

  it("succeeds when trigger returns 202 (cage waking)", async () => {
    // Trigger: cage was stopped, now waking
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "waking" }, 202),
    );
    // Poll: cage stopped after work
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ available: false, status: "stopped" }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("includes auth header when openclawAuthToken is provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ available: false, status: "stopped" }),
    );

    await execute(makeCtx({ openclawAuthToken: "secret-token" }));

    const triggerCall = mockFetch.mock.calls[0];
    const requestInit = triggerCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
  });

  it("returns timeout result when polling exceeds deadline", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    // Always return active heartbeat
    mockFetch.mockResolvedValue(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: 1000, lastEnd: null },
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
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ available: false, status: "stopped" }),
    );

    await execute(makeCtx());

    const triggerUrl = mockFetch.mock.calls[0][0] as string;
    expect(triggerUrl).toBe(
      "https://gateway.lobstercage.ai/hook/cage_abc/tok123/hooks/wake",
    );
  });
});
