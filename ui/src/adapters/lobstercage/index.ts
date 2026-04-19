import type { UIAdapterModule } from "../types";
import { parseLobsterCageStdoutLine } from "@paperclipai/adapter-lobstercage/ui";
import { buildLobsterCageConfig } from "@paperclipai/adapter-lobstercage/ui";
import { LobsterCageConfigFields } from "./config-fields";

export const lobsterCageUIAdapter: UIAdapterModule = {
  type: "lobstercage",
  label: "LobsterCage",
  parseStdoutLine: parseLobsterCageStdoutLine,
  ConfigFields: LobsterCageConfigFields,
  buildAdapterConfig: buildLobsterCageConfig,
};
