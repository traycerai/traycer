import { createFileRoute } from "@tanstack/react-router";
import { SkillsSettingsPanel } from "@/components/settings/panels/providers-settings-panel";

export const Route = createFileRoute("/settings/skills")({
  component: SkillsSettingsPanel,
});
