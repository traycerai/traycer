import { createFileRoute } from "@tanstack/react-router";
import { BrowserSettingsPanel } from "@/components/settings/panels/browser-settings-panel";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsPanel,
});
