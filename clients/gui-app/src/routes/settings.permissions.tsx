import { createFileRoute } from "@tanstack/react-router";
import { PermissionsSettingsPanel } from "@/components/settings/panels/permissions-settings-panel";

export const Route = createFileRoute("/settings/permissions")({
  component: PermissionsSettingsPanel,
});
