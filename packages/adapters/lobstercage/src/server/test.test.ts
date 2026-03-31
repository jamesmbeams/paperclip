import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testEnvironment } from "./test.js";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
  it("fails when webhookUrl is missing", async () => {
    const result = await testEnvironment(makeCtx({}));
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "lobstercage_webhook_url_missing")).toBe(true);
  });

  it("fails when webhookUrl is not a valid URL", async () => {
    const result = await testEnvironment(makeCtx({ webhookUrl: "not-a-url" }));
    expect(result.status).toBe("fail");
    const check = result.checks.find((c) => c.code === "lobstercage_webhook_url_invalid");
    expect(check).toBeDefined();
    // Should not leak the URL value in the message
    expect(check!.message).not.toContain("not-a-url");
  });

  it("does not leak webhook token in error messages", async () => {
    const result = await testEnvironment(
      makeCtx({ webhookUrl: "https://gw.test/wrong/path/secrettoken123" }),
    );
    for (const check of result.checks) {
      expect(check.message).not.toContain("secrettoken123");
      expect(check.detail ?? "").not.toContain("secrettoken123");
    }
  });

  it("fails when webhookUrl path format is wrong", async () => {
    const result = await testEnvironment(
      makeCtx({ webhookUrl: "https://gw.test/wrong/path" }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "lobstercage_webhook_url_format")).toBe(true);
  });

  it("passes and probes status endpoint when URL is valid", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ available: true, status: "running" }),
    );

    const result = await testEnvironment(
      makeCtx({
        webhookUrl: "https://gw.test/hook/cage_abc/tok123",
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "lobstercage_webhook_url_valid")).toBe(true);
    expect(result.checks.some((c) => c.code === "lobstercage_status_probe_ok")).toBe(true);

    // Verify it probed the correct status URL
    expect(mockFetch).toHaveBeenCalledWith(
      "https://gw.test/status/cage_abc/tok123",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("warns when status probe returns non-200", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

    const result = await testEnvironment(
      makeCtx({
        webhookUrl: "https://gw.test/hook/cage_abc/tok123",
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "lobstercage_status_probe_failed")).toBe(true);
  });

  it("warns when status probe times out", async () => {
    mockFetch.mockRejectedValueOnce(new Error("aborted"));

    const result = await testEnvironment(
      makeCtx({
        webhookUrl: "https://gw.test/hook/cage_abc/tok123",
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "lobstercage_status_probe_error")).toBe(true);
  });

  it("errors when cage is destroyed", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ available: false, status: "destroyed" }),
    );

    const result = await testEnvironment(
      makeCtx({
        webhookUrl: "https://gw.test/hook/cage_abc/tok123",
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "lobstercage_cage_destroyed")).toBe(true);
  });
});
