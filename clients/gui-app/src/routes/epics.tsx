import { createFileRoute } from "@tanstack/react-router";
import { EpicsLayoutRoute } from "./epics-layout-route-components";

export const Route = createFileRoute("/epics")({
  component: EpicsLayoutRoute,
});
