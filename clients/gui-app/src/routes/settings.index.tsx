import { createFileRoute } from "@tanstack/react-router";
import { SettingsIndexRedirect } from "./settings-index-route-components";

export const Route = createFileRoute("/settings/")({
  component: SettingsIndexRedirect,
});
