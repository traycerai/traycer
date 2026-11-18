import { createFileRoute } from "@tanstack/react-router";
import { MembersSettingsPanel } from "@/components/settings/environment/members-settings-panel";

export const Route = createFileRoute("/settings/members")({
  component: MembersSettingsPanel,
});
