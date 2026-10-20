import { createFileRoute } from "@tanstack/react-router";
import { BrowserAgentAccessSettingsPanel } from "@/components/settings/panels/browser-agent-access-settings-panel";

export const Route = createFileRoute("/settings/browser-agent-access")({
  component: BrowserAgentAccessSettingsPanel,
});
