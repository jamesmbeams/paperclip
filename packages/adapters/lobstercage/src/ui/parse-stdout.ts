import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseLobsterCageStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
