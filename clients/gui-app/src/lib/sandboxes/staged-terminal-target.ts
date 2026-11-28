import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

/** A handoff has already placed the surface on the sandbox's computer. */
export function stageTakingTerminal(
  stage: StagedSandbox | null,
): StagedSandbox | null {
  return stage?.phase === "handoff" ? null : stage;
}
