import { createFileRoute } from "@tanstack/react-router";
import { DevicesSessionsPanel } from "@/components/settings/panels/devices-sessions-panel";

export const Route = createFileRoute("/settings/devices")({
  component: DevicesSessionsPanel,
});
