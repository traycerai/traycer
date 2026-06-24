import { createFileRoute } from "@tanstack/react-router";
import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";

export const Route = createFileRoute("/settings/agents")({
  component: AgentsSettingsPanel,
});
