export type ComposerTopBannerKind =
  "reauth" | "ambient-drift" | "rate-limit" | "none";

export function resolveComposerTopBannerKind({
  profileDisabled,
  reauthVisible,
  ambientDriftVisible,
  rateLimitVisible,
}: {
  readonly profileDisabled: boolean;
  readonly reauthVisible: boolean;
  readonly ambientDriftVisible: boolean;
  readonly rateLimitVisible: boolean;
}): ComposerTopBannerKind {
  if (profileDisabled) return "none";
  if (reauthVisible) return "reauth";
  if (ambientDriftVisible) return "ambient-drift";
  if (rateLimitVisible) return "rate-limit";
  return "none";
}
