import { describe, it, expect } from "vitest";
import { parseWebhookUrl } from "./parse-webhook-url.js";

describe("parseWebhookUrl", () => {
  it("extracts domain, cageId, and webhookToken from a well-formed LobsterCage URL", () => {
    expect(
      parseWebhookUrl("https://gateway.lobstercage.ai/hook/cage_abc/tok123"),
    ).toEqual({
      domain: "https://gateway.lobstercage.ai",
      cageId: "cage_abc",
      webhookToken: "tok123",
    });
  });

  it("throws on URLs that don't match the /hook/{cageId}/{webhookToken} shape", () => {
    expect(() => parseWebhookUrl("https://gateway.lobstercage.ai/hook/cage_abc"))
      .toThrow(/LobsterCage webhook URL/);
    expect(() => parseWebhookUrl("https://gateway.lobstercage.ai/not-a-hook/"))
      .toThrow(/LobsterCage webhook URL/);
    expect(() => parseWebhookUrl("not-a-url")).toThrow();
  });
});
