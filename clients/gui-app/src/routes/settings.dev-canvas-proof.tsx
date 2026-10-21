import { createFileRoute } from "@tanstack/react-router";
import { CanvasProofRoute } from "./settings-dev-canvas-proof-route-components";
export const Route = createFileRoute("/settings/dev-canvas-proof")({
  component: CanvasProofRoute,
});
