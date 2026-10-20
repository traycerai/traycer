import { createFileRoute } from "@tanstack/react-router";
import { AgentDefinitionsSettingsPanel } from "@/components/settings/panels/agent-definitions-settings-panel";

export const Route = createFileRoute("/settings/agent-definitions")({
  component: AgentDefinitionsSettingsPanel,
});
