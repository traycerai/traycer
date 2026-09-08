export function repositoryTabFill(color: string | null | undefined): string {
  return color === null || color === undefined
    ? "var(--color-background)"
    : `color-mix(in srgb, ${color} 12%, var(--color-background))`;
}
