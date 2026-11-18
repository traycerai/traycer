import { createFileRoute } from "@tanstack/react-router";
import { MachineSetupSettingsPanel } from "@/components/settings/panels/machine-setup-settings-panel";

export const Route = createFileRoute("/settings/machine-setup")({
  component: MachineSetupSettingsPanel,
});
