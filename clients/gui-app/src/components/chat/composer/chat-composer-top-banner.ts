export type ComposerTopBannerKind = "reauth" | "rate-limit" | "none";

export function resolveComposerTopBannerKind({
  profileDisabled,
  reauthVisible,
  rateLimitVisible,
}: {
  readonly profileDisabled: boolean;
  readonly reauthVisible: boolean;
  readonly rateLimitVisible: boolean;
}): ComposerTopBannerKind {
  if (profileDisabled) return "none";
  if (reauthVisible) return "reauth";
  if (rateLimitVisible) return "rate-limit";
  return "none";
}
