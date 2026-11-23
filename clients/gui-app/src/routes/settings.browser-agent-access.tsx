import { createFileRoute } from "@tanstack/react-router";
import { BrowserAgentAccessSettingsPanel } from "@/components/settings/panels/browser-agent-access-settings-panel";

/**
 * Legacy path: a remembered path or a deep link opens Browser agent access in
 * place, never rewritten to Permissions, so a computer without the page says
 * so under its own heading.
 */
export const Route = createFileRoute("/settings/browser-agent-access")({
  component: BrowserAgentAccessSettingsPanel,
});
