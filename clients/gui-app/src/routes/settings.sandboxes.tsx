import { createFileRoute } from "@tanstack/react-router";
import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";

export const Route = createFileRoute("/settings/sandboxes")({
  component: SandboxesSettingsPanel,
});
