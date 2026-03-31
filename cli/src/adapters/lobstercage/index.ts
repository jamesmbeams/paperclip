import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { printLobsterCageStdoutEvent } from "./format-event.js";

export const lobsterCageCLIAdapter: CLIAdapterModule = {
  type: "lobstercage",
  formatStdoutEvent: printLobsterCageStdoutEvent,
};
