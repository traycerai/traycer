import { createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "@/components/settings/settings-layout";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});
