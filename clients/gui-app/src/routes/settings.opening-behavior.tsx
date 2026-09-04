import { createFileRoute } from "@tanstack/react-router";
import { OpeningBehaviorPanel } from "@/components/settings/panels/opening-behavior-panel";

export const Route = createFileRoute("/settings/opening-behavior")({
  component: OpeningBehaviorPanel,
});
