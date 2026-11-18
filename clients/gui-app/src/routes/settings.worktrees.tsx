import { createFileRoute } from "@tanstack/react-router";
import { WorktreesSettingsPanel } from "@/components/settings/panels/worktrees-settings-panel";

export const Route = createFileRoute("/settings/worktrees")({
  component: WorktreesSettingsPanel,
});
