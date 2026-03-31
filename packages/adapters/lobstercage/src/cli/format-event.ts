import pc from "picocolors";

export function printLobsterCageStdoutEvent(
  raw: string,
  _debug: boolean,
): void {
  const line = raw.trim();
  if (!line) return;

  if (line.includes("Triggering heartbeat")) {
    console.log(pc.blue(line));
  } else if (line.includes("Heartbeat completed")) {
    console.log(pc.green(line));
  } else if (line.includes("error") || line.includes("failed")) {
    console.log(pc.red(line));
  } else if (line.startsWith("Cage status:")) {
    console.log(pc.gray(line));
  } else {
    console.log(line);
  }
}
