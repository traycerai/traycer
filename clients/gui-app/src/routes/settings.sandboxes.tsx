import { createFileRoute } from "@tanstack/react-router";
import { SandboxesSettingsPanel } from "@/components/settings/environment/sandboxes-page-slot";

export const Route = createFileRoute("/settings/sandboxes")({
  component: SandboxesSettingsPanel,
});
