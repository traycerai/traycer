import { createFileRoute } from "@tanstack/react-router";
import { StorageSettingsPanel } from "@/components/settings/environment/storage-settings-panel";

export const Route = createFileRoute("/settings/storage")({
  component: StorageSettingsPanel,
});
