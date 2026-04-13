import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function LobsterCageConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field
        label="Webhook URL"
        hint="Full LobsterCage webhook URL (https://{domain}/hook/{cageId}/{token})"
      >
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff(
                  "adapterConfig",
                  "webhookUrl",
                  String(config.webhookUrl ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "webhookUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://gateway.lobstercage.ai/hook/cage_abc/..."
        />
      </Field>
      <Field
        label="OpenClaw Hook Token"
        hint="Recommended token for triggering /hooks/wake inside the cage"
      >
        <DraftInput
          value={
            isCreate
              ? String(values!.openclawAuthToken ?? "")
              : eff(
                  "adapterConfig",
                  "openclawAuthToken",
                  String(config.openclawAuthToken ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ openclawAuthToken: v })
              : mark("adapterConfig", "openclawAuthToken", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="Recommended for modern OpenClaw hooks"
        />
      </Field>
    </>
  );
}
