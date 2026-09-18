import { createFileRoute } from "@tanstack/react-router";
import { LayoutSettingsRoute } from "@/components/settings/panels/layout-settings-route";

export const Route = createFileRoute("/settings/layout")({
  component: LayoutSettingsRoute,
});
