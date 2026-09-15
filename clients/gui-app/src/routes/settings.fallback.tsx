import { createFileRoute } from "@tanstack/react-router";
import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";

export const Route = createFileRoute("/settings/fallback")({
  component: FallbackSettingsPanel,
});
