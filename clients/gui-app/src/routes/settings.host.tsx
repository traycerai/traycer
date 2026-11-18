import { createFileRoute } from "@tanstack/react-router";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";

export const Route = createFileRoute("/settings/host")({
  component: HostSettingsPanel,
});
