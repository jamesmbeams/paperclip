import type { TranscriptEntry } from "../types";

export function parseLobsterCageStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
