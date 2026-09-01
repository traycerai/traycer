import { createFileRoute } from "@tanstack/react-router";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";

export const Route = createFileRoute("/settings/app-notifications")({
  component: AppNotificationsSettingsPanel,
});
