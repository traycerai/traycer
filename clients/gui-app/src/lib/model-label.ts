import type { GuiAgentModelOption } from "@traycer/protocol/host/index";

export function modelLabelForDisplay(
  model: Pick<GuiAgentModelOption, "harnessId" | "slug" | "label">,
): string {
  return model.harnessId === "claude" && model.slug === "default"
    ? "Default"
    : model.label;
}
