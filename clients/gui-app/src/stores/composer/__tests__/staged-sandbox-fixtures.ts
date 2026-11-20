import type { StagedSandboxTarget } from "@/stores/composer/staged-sandbox-store";

/** A new sandbox picked in a composer: nothing created, so no host yet. */
export const STAGED_NEW_TARGET: Extract<
  StagedSandboxTarget,
  { readonly kind: "new" }
> = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "api-refactor",
  wakeString: null,
};

/** One of the person's resting sandboxes, picked to wake; it runs on `hostId`. */
export function stagedExistingTarget(
  hostId: string,
): Extract<StagedSandboxTarget, { readonly kind: "existing" }> {
  return {
    kind: "existing",
    hostId,
    sandboxId: "sandbox-1",
    name: "build-box",
    configuration: { kind: "personal" },
    verb: "resume",
  };
}
