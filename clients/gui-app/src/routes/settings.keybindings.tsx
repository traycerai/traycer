import { createFileRoute } from "@tanstack/react-router";
import { KeybindingsSettingsPanel } from "@/components/settings/panels/keybindings-settings-panel";

export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsSettingsPanel,
});
