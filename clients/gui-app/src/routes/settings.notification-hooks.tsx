import { createFileRoute } from "@tanstack/react-router";
import { TeamNotificationHooksSettingsPanel } from "@/components/settings/environment/team-notification-hooks-settings-panel";

export const Route = createFileRoute("/settings/notification-hooks")({
  component: TeamNotificationHooksSettingsPanel,
});
