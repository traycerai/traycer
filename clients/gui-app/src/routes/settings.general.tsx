import { createFileRoute } from "@tanstack/react-router";
import { settingsSectionRouteComponent } from "@/components/settings/settings-section-route-component";

export const Route = createFileRoute("/settings/general")({
  component: settingsSectionRouteComponent("general"),
});
