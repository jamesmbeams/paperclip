import pc from "picocolors";

export function printLobsterCageStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    console.log(line);
    return;
  }

  if (line.startsWith("Runtime run")) {
    console.log(pc.cyan(line));
    return;
  }

  if (line.startsWith("Accepted")) {
    console.log(pc.green(line));
    return;
  }

  if (line.startsWith("Submitting")) {
    console.log(pc.blue(line));
    return;
  }

  console.log(pc.gray(line));
}
