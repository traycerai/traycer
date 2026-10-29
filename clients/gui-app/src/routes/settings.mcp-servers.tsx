import { createFileRoute, redirect } from "@tanstack/react-router";
import { McpServersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const Route = createFileRoute("/settings/mcp-servers")({
  // The environment-wide page is not a page of a build without environments
  // (each provider's own tab stays): a remembered path lands on Settings.
  beforeLoad: () => {
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/settings", replace: true });
    }
  },
  component: McpServersSettingsPanel,
});
