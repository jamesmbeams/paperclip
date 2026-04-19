import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { testEnvironment } from "./test.js";

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx(
  config: Record<string, unknown> = {},
): AdapterEnvironmentTestContext {
  return {
    companyId: "co-1",
    adapterType: "lobstercage",
    config,
  };
}

describe("testEnvironment", () => {
  it("reports lobstercage_webhook_url_missing when webhookUrl is absent", async () => {
    const result = await testEnvironment(makeCtx({}));
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "lobstercage_webhook_url_missing")).toBe(true);
  });

  it("reports lobstercage_webhook_url_format when webhookUrl is malformed", async () => {
    const result = await testEnvironment(
      makeCtx({ webhookUrl: "https://gateway.example.com/not-a-hook/" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "lobstercage_webhook_url_format")).toBe(true);
  });

  it("reports lobstercage_status_probe_ok when the cage is reachable and available=true", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ available: true, status: "running" }), { status: 200 }),
    );
    const result = await testEnvironment(
      makeCtx({ webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok" }),
    );
    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "lobstercage_webhook_url_valid")).toBe(true);
    expect(result.checks.some((c) => c.code === "lobstercage_status_probe_ok")).toBe(true);
    expect((mockFetch.mock.calls[0][0] as string)).toBe(
      "https://gateway.lobstercage.ai/status/cage_abc/tok",
    );
  });

  it("warns with lobstercage_cage_unavailable when the cage returns 200 { available: false } (stopped/hibernating)", async () => {
    // The LobsterCage gateway returns 200 + available:false for
    // stopped/hibernating/unreachable cages. A naive res.ok check would
    // falsely report the probe as healthy; the probe must parse the body
    // and surface the real cage state to the operator.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ available: false, status: "stopped" }), { status: 200 }),
    );
    const result = await testEnvironment(
      makeCtx({ webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok" }),
    );
    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "lobstercage_cage_unavailable")).toBe(true);
    const unavailable = result.checks.find((c) => c.code === "lobstercage_cage_unavailable");
    expect(unavailable?.message).toContain("stopped");
  });

  it("reports lobstercage_status_probe_failed on non-2xx probe; _error on fetch throw", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    const result = await testEnvironment(
      makeCtx({ webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "lobstercage_status_probe_failed")).toBe(true);

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result2 = await testEnvironment(
      makeCtx({ webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok" }),
    );
    expect(result2.status).toBe("fail");
    expect(result2.checks.some((c) => c.code === "lobstercage_status_probe_error")).toBe(true);
  });
});
