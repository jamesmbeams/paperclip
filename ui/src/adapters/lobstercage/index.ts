import type { UIAdapterModule } from "../types";
import { parseLobsterCageStdoutLine } from "./parse-stdout";
import { LobsterCageConfigFields } from "./config-fields";
import { buildLobsterCageConfig } from "./build-config";

export const lobsterCageUIAdapter: UIAdapterModule = {
  type: "lobstercage",
  label: "LobsterCage",
  parseStdoutLine: parseLobsterCageStdoutLine,
  ConfigFields: LobsterCageConfigFields,
  buildAdapterConfig: buildLobsterCageConfig,
};
