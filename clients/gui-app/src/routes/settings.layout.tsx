import { createFileRoute } from "@tanstack/react-router";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";

export const Route = createFileRoute("/settings/layout")({
  component: LayoutSettingsPanel,
});
