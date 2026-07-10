export type ComposerTopBannerKind =
  "reauth" | "ambient-drift" | "rate-limit" | "none";

export function resolveComposerTopBannerKind({
  reauthVisible,
  ambientDriftVisible,
  rateLimitVisible,
}: {
  readonly reauthVisible: boolean;
  readonly ambientDriftVisible: boolean;
  readonly rateLimitVisible: boolean;
}): ComposerTopBannerKind {
  if (reauthVisible) return "reauth";
  if (ambientDriftVisible) return "ambient-drift";
  if (rateLimitVisible) return "rate-limit";
  return "none";
}
