import { createFileRoute } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";

/**
 * The Tracy surface with no channel selected (decision 150): the pane says
 * bots are created from Home. The tab-kind descriptor renders the surface
 * once inside `TopLevelTabHost`, as for `/bot/$botId`.
 */
export const Route = createFileRoute("/bot/")({
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  component: () => null,
});
