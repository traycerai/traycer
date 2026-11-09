import { createFileRoute } from "@tanstack/react-router";
import { AgentMemoriesSettingsPanel } from "@/components/settings/panels/agent-memories-settings-panel";

export const Route = createFileRoute("/settings/agent-memories")({
  component: AgentMemoriesSettingsPanel,
});
