/** Resolve a stage's name once, before either a send or a terminal creates it. */
export function stagedSandboxName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > 0) return trimmed;
  const suffix = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `sandbox-${suffix}`;
}
