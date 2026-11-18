import { createFileRoute } from "@tanstack/react-router";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettingsPanel,
});
