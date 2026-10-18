import { createFileRoute } from "@tanstack/react-router";
import { ArtifactProofRoute } from "./artifact-proof-route-components";

export const Route = createFileRoute("/dev/artifact-proof")({
  component: ArtifactProofRoute,
});
