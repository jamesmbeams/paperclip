import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildLobsterCageConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "lobstercage",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildLobsterCageConfig", () => {
  it("emits the webhookUrl and timing defaults from a valid values.url", () => {
    const config = buildLobsterCageConfig(
      makeValues({ url: "https://gateway.lobstercage.ai/hook/cage_abc/tok" }),
    );
    expect(config).toEqual({
      webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok",
      timeoutSec: 600,
      pollIntervalSec: 2,
    });
  });

  it("omits webhookUrl entirely when values.url is empty", () => {
    const config = buildLobsterCageConfig(makeValues({ url: "" }));
    expect(config).not.toHaveProperty("webhookUrl");
    expect(config).toMatchObject({ timeoutSec: 600, pollIntervalSec: 2 });
  });
});
