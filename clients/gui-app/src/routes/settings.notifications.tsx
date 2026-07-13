import { createFileRoute } from "@tanstack/react-router";
import { NotificationsSettingsPanel } from "@/components/settings/panels/notifications-settings-panel";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsSettingsPanel,
});
