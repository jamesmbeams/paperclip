import { describe, expect, it } from "vitest";
import { buildLobsterCageConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

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
    openclawAuthToken: "",
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
  it("includes the hook token when provided at create time", () => {
    const config = buildLobsterCageConfig(
      makeValues({
        url: "https://gateway.lobstercage.ai/hook/cage_abc/tok123",
        openclawAuthToken: " hook-secret ",
      }),
    );

    expect(config).toMatchObject({
      webhookUrl: "https://gateway.lobstercage.ai/hook/cage_abc/tok123",
      openclawAuthToken: "hook-secret",
      timeoutSec: 600,
      pollIntervalSec: 5,
    });
  });

  it("omits the hook token when left blank", () => {
    const config = buildLobsterCageConfig(makeValues());

    expect(config).not.toHaveProperty("openclawAuthToken");
  });
});
