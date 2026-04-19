import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildInvokeEnvelope } from "./build-envelope.js";

function makeCtx(overrides: {
  runId?: string;
  agentId?: string;
  companyId?: string;
  context?: Record<string, unknown>;
  config?: Record<string, unknown>;
} = {}): AdapterExecutionContext {
  return {
    runId: overrides.runId ?? "run-fixed-1",
    agent: {
      id: overrides.agentId ?? "agent-1",
      companyId: overrides.companyId ?? "co-1",
      name: "Test",
      adapterType: "lobstercage",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: overrides.config ?? { webhookUrl: "https://gateway/hook/c/t" },
    context: overrides.context ?? {},
    onLog: async () => {},
  };
}

beforeEach(() => {
  process.env.PAPERCLIP_API_URL = "https://paperclip.example.com";
});

afterEach(() => {
  delete process.env.PAPERCLIP_API_URL;
});

describe("buildInvokeEnvelope", () => {
  it("emits version v1 and core run fields from ctx", () => {
    const env = buildInvokeEnvelope(
      makeCtx({ runId: "run-xyz", agentId: "a-1", companyId: "co-2" }),
    );
    expect(env.version).toBe("v1");
    expect(env.run.runId).toBe("run-xyz");
    expect(env.run.agentId).toBe("a-1");
    expect(env.run.companyId).toBe("co-2");
  });

  it("always emits a non-empty run.wakeReason — defaults to 'paperclip_wake' when absent", () => {
    // ctx.context.wakeReason present → used verbatim
    const envWith = buildInvokeEnvelope(
      makeCtx({ context: { wakeReason: "issue_assigned" } }),
    );
    expect(envWith.run.wakeReason).toBe("issue_assigned");

    // ctx.context.wakeReason missing → default, not empty/null
    const envWithout = buildInvokeEnvelope(makeCtx({ context: {} }));
    expect(envWithout.run.wakeReason).toBe("paperclip_wake");

    // ctx.context.wakeReason empty string → treated as missing
    const envEmpty = buildInvokeEnvelope(makeCtx({ context: { wakeReason: "" } }));
    expect(envEmpty.run.wakeReason).toBe("paperclip_wake");
  });

  it("hard-codes run.source to 'paperclip' (ignores ctx overrides)", () => {
    const env = buildInvokeEnvelope(
      makeCtx({ context: { source: "impostor" } }),
    );
    expect(env.run.source).toBe("paperclip");
  });

  it("resolves task.taskId as taskId-over-issueId when both ctx.context.taskId and issueId are set and differ", () => {
    // Regression test: current Paperclip producers set taskId === issueId
    // and resume logic treats taskId as canonical with issueId as fallback.
    // Lock that semantic here so a future change doesn't silently flip
    // precedence (which would point the cage at the wrong issue).
    const env = buildInvokeEnvelope(
      makeCtx({ context: { taskId: "task-canonical", issueId: "issue-different" } }),
    );
    expect(env.task.kind).toBe("issue_execution");
    expect(env.task.taskId).toBe("task-canonical");
  });

  it("sets task.kind=issue_execution with resolved taskId when one is available, else heartbeat", () => {
    const withTask = buildInvokeEnvelope(
      makeCtx({ context: { taskId: "issue-42" } }),
    );
    expect(withTask.task.kind).toBe("issue_execution");
    expect(withTask.task.taskId).toBe("issue-42");

    const withIssueIdOnly = buildInvokeEnvelope(
      makeCtx({ context: { issueId: "issue-99" } }),
    );
    expect(withIssueIdOnly.task.kind).toBe("issue_execution");
    expect(withIssueIdOnly.task.taskId).toBe("issue-99");

    const bare = buildInvokeEnvelope(makeCtx({ context: {} }));
    expect(bare.task.kind).toBe("heartbeat");
    expect(bare.task.taskId).toBeNull();
  });

  it("reflects ctx.context.checkedOutByHarness on task.checkedOutByHarness (defaults false)", () => {
    expect(buildInvokeEnvelope(makeCtx({ context: {} })).task.checkedOutByHarness).toBe(false);
    expect(
      buildInvokeEnvelope(makeCtx({ context: { checkedOutByHarness: true } })).task.checkedOutByHarness,
    ).toBe(true);
    expect(
      buildInvokeEnvelope(makeCtx({ context: { checkedOutByHarness: "truthy" } })).task.checkedOutByHarness,
    ).toBe(false); // only exact `true` counts
  });

  it("derives execution.sessionKey, timeoutMs, and upstream.baseUrl deterministically", () => {
    const env = buildInvokeEnvelope(
      makeCtx({
        agentId: "a-7",
        context: { taskId: "issue-7", forceFreshSession: true },
        config: { webhookUrl: "https://gateway/hook/c/t", timeoutSec: 120 },
      }),
    );
    expect(env.execution.sessionKey).toBe("agent:a-7:issue:issue-7");
    expect(env.execution.sessionPolicy).toBe("fresh");
    expect(env.execution.timeoutMs).toBe(120_000);
    expect(env.upstream.type).toBe("paperclip");
    expect(env.upstream.baseUrl).toBe("https://paperclip.example.com");

    const bare = buildInvokeEnvelope(
      makeCtx({ agentId: "a-7", context: {}, config: { webhookUrl: "x" } }),
    );
    expect(bare.execution.sessionKey).toBe("agent:a-7:heartbeat");
    expect(bare.execution.sessionPolicy).toBe("reuse");
    expect(bare.execution.timeoutMs).toBe(600_000); // default
  });
});
