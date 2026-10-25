import type {
  EnvironmentSecretRemoval,
  EnvironmentSecretRemovalV12,
} from "@traycer/protocol/host/environment-schemas";

type RemovalTarget = EnvironmentSecretRemovalV12["targets"][number];

/**
 * `removal` with each target's failure from the list's copy of the same
 * removal: the versions read is the newer fact about how far it reached,
 * and carries no failures. A target no longer `requested` has none.
 */
export function removalWithFailures(
  removal: EnvironmentSecretRemoval,
  listed: EnvironmentSecretRemovalV12 | null,
): EnvironmentSecretRemovalV12 {
  return {
    ...removal,
    targets: removal.targets.map((target) => ({
      ...target,
      failedAt:
        target.state === "requested"
          ? (listed?.targets.find(
              (entry) =>
                entry.target === target.target &&
                entry.hostId === target.hostId,
            )?.failedAt ?? null)
          : null,
    })),
  };
}

/**
 * The hosts that said they couldn't delete their copy: "dev-box couldn't
 * delete its copy", "2 hosts couldn't delete their copies", or null when
 * none did.
 */
export function failedHostsText(
  removal: EnvironmentSecretRemovalV12,
  nameOf: (target: RemovalTarget) => string,
): string | null {
  const failed = removal.targets.filter(
    (target) =>
      target.target === "host" &&
      target.state === "requested" &&
      target.failedAt !== null,
  );
  if (failed.length === 0) return null;
  if (failed.length > 1) {
    return `${failed.length} hosts couldn't delete their copies`;
  }
  return `${nameOf(failed[0])} couldn't delete its copy`;
}
