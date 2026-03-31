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
  it("detects heartbeat completion via lastEnd > invokeTime", async () => {
    const invokeTime = 1000;

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
    expect(result.summary).toBe("Heartbeat completed");
  });

  it("detects completion when cage stops (hibernated)", async () => {
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

    expect(result.completed).toBe(true);
    expect(result.cageStatus).toBe("stopped");
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
      Date.now() + 250, // very short deadline
      100,
    );

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("ignores lastEnd from before invokeTime", async () => {
    const invokeTime = 2000;

    // First poll: heartbeat not active but lastEnd is from a previous run
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: true,
        status: "running",
        heartbeat: {
          enabled: true,
          possiblyActive: false,
          lastStart: 500,
          lastEnd: 800, // before invokeTime
        },
      }),
    );
    // Second poll: heartbeat completed after invoke
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
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("continues polling on fetch error", async () => {
    const onLog = vi.fn();

    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "stopped",
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      1000,
      Date.now() + 60_000,
      100,
      onLog,
    );

    expect(result.completed).toBe(true);
    expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("network failure"));
  });

  it("continues polling on non-200 status", async () => {
    const onLog = vi.fn();

    mockFetch.mockResolvedValueOnce(new Response("", { status: 502 }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        available: false,
        status: "hibernating",
      }),
    );

    const result = await pollForCompletion(
      "https://gw.test/status/cage1/tok1",
      1000,
      Date.now() + 60_000,
      100,
      onLog,
    );

    expect(result.completed).toBe(true);
    expect(result.cageStatus).toBe("hibernating");
  });
});
