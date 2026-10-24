import { createFileRoute } from "@tanstack/react-router";
import { ArtifactProofRoute } from "./settings-dev-artifact-proof-route-components";

export const Route = createFileRoute("/settings/dev-artifact-proof")({
  component: ArtifactProofRoute,
});
