import { createFileRoute } from "@tanstack/react-router";
import { WhenYouQuitRoute } from "./when-you-quit-route-components";

export const Route = createFileRoute("/when-you-quit")({
  component: WhenYouQuitRoute,
});
