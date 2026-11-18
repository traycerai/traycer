import { createFileRoute } from "@tanstack/react-router";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";

export const Route = createFileRoute("/settings/secrets")({
  component: SecretsSettingsPanel,
});
