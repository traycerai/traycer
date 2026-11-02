import { createFileRoute } from "@tanstack/react-router";
import { McpServersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";

export const Route = createFileRoute("/settings/mcp-servers")({
  component: McpServersSettingsPanel,
});
