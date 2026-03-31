import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollForCompletion } from "./poll.js";

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

describe("pollForCompletion", () => {
  it("detects heartbeat completion via active→inactive transition", async () => {
    const invokeTime = 1000;

    // Poll 1: heartbeat started after invoke, still active
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: true,
          lastStart: 1100,
          lastEnd: null,
        },
      }),
    );
    // Poll 2: heartbeat completed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: 1100,
          lastEnd: 1500,
        },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      invokeTime,
      Date.now() + 60_000,
      100,
    );

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.summary).toBe("Heartbeat completed");
  });

  it("detects completion when cage stops after heartbeat was active", async () => {
    const invokeTime = 1000;

    // Poll 1: heartbeat active
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: 1100, lastEnd: null },
      }),
    );
    // Poll 2: cage stopped
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: 1100, lastEnd: null },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      invokeTime,
      Date.now() + 60_000,
      100,
    );

    expect(result.completed).toBe(true);
    expect(result.cageStatus).toBe("stopped");
  });

  it("fails when cage stops without heartbeat evidence", async () => {
    // Cage stopped but no heartbeat was ever observed for this invoke
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: null, lastEnd: null },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      1000,
      Date.now() + 60_000,
      100,
    );

    expect(result.completed).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.summary).toContain("without running heartbeat");
  });

  it("fails immediately when cage is destroyed", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "destroyed",
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      1000,
      Date.now() + 60_000,
      100,
    );

    expect(result.completed).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.cageStatus).toBe("destroyed");
    expect(result.summary).toContain("destroyed");
  });

  it("returns timedOut when deadline exceeded", async () => {
    // Always return active heartbeat
    mockFetch.mockResolvedValue(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: 1100, lastEnd: null },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      1000,
      Date.now() + 250,
      100,
    );

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.failed).toBe(false);
  });

  it("ignores stale heartbeat from before invokeTime", async () => {
    const invokeTime = 2000;

    // Poll 1: heartbeat not active but lastStart is from a previous run
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: 500,
          lastEnd: 800,
        },
      }),
    );
    // Poll 2: new heartbeat started after invoke, still active
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: true,
          lastStart: 2100,
          lastEnd: null,
        },
      }),
    );
    // Poll 3: heartbeat completed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: 2100,
          lastEnd: 2500,
        },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      invokeTime,
      Date.now() + 60_000,
      100,
    );

    expect(result.completed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("ignores concurrent heartbeat that started before invokeTime", async () => {
    const invokeTime = 2000;

    // A concurrent heartbeat started before our invoke and finishes after
    // This should NOT satisfy completion — lastStart < invokeTime
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: 1500,
          lastEnd: 2100,
        },
      }),
    );
    // Our heartbeat starts
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: true,
          lastStart: 2200,
          lastEnd: null,
        },
      }),
    );
    // Our heartbeat completes
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: 2200,
          lastEnd: 2800,
        },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      invokeTime,
      Date.now() + 60_000,
      100,
    );

    expect(result.completed).toBe(true);
    // First poll should not have matched — 3 polls needed
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("continues polling on fetch error", async () => {
    const onLog = vi.fn();
    const invokeTime = 1000;

    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    // After error, heartbeat active
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: 1100, lastEnd: null },
      }),
    );
    // Then completed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: 1100, lastEnd: 1500 },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      invokeTime,
      Date.now() + 60_000,
      100,
      onLog,
    );

    expect(result.completed).toBe(true);
    expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("network failure"));
  });

  it("continues polling on non-200 status", async () => {
    const onLog = vi.fn();
    const invokeTime = 1000;

    mockFetch.mockResolvedValueOnce(new Response("", { status: 502 }));
    // After error, heartbeat active then done
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: { enabled: true, possiblyActive: true, lastStart: 1100, lastEnd: null },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "hibernating",
        heartbeat: { enabled: true, possiblyActive: false, lastStart: 1100, lastEnd: null },
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      invokeTime,
      Date.now() + 60_000,
      100,
      onLog,
    );

    expect(result.completed).toBe(true);
    expect(result.cageStatus).toBe("hibernating");
  });
});
