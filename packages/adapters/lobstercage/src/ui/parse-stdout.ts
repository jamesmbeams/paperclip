import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Parse a stdout line from the lobstercage adapter's structured log output.
 *
 * The lobstercage adapter does not stream assistant/tool events — all such
 * content is orchestrated inside the cage by the runtime's own runner. The
 * adapter itself only emits orchestration breadcrumbs ("Submitting…",
 * "Accepted. runtimeRunId=…", "Runtime run … terminated with status=…").
 * Those lines render as plain stdout entries; there's no assistant-message
 * framing to extract.
 */
export function parseLobsterCageStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  return [{ kind: "stdout", ts, text: trimmed }];
}
