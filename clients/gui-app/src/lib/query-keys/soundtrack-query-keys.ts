export const soundtrackQueryKeys = {
  /**
   * The team's track set on a build that has one. No arguments: a build reads
   * one set. Every read is a real one and nothing is held
   * (`lib/soundtrack/desktop-set.ts`), because its samples are signed links.
   */
  teamSet: () => ["soundtrack", "team-set"] as const,
};
