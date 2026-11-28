/**
 * Retirement aborts signal synchronously, before or with isCurrent() becoming
 * false. The signal drives rendered withdrawal; isCurrent fences async work
 * before dispatch and after completion.
 */
export interface ArtifactReadLifetime {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export function artifactReadIsCurrent(
  lifetime: ArtifactReadLifetime | null,
): boolean {
  return (
    lifetime === null || (!lifetime.signal.aborted && lifetime.isCurrent())
  );
}

export function assertArtifactReadLive(
  lifetime: ArtifactReadLifetime | null,
): void {
  if (!artifactReadIsCurrent(lifetime)) {
    throw new DOMException("Artifact reader retired", "AbortError");
  }
}
