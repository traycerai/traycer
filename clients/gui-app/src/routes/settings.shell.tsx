import { createFileRoute } from "@tanstack/react-router";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";

export const Route = createFileRoute("/settings/shell")({
  component: ShellSettingsPanel,
});
