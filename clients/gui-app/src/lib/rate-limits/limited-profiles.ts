import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { providerDisplayName } from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * A profile the host reports as `limited` on at least one of its windows.
 *
 * The host decides the tier (`semantics.ts`); this only collects the profiles
 * that reached it, for the two places that mark them: the usage popover's
 * banner and its provider rail.
 */
export interface LimitedProfile {
  readonly providerId: RateLimitProviderId;
  /** The account's profile id, `null` for the provider's ambient login. */
  readonly profileId: string | null;
  /** The account's name, or the provider's where it has no account mark. */
  readonly name: string;
  /** The limit it hit, in a sentence slot: `weekly`, `5h`, `Fable`. */
  readonly limitName: string;
  /** When the blocking window resets, or `null` where the host gave none. */
  readonly resetsAt: number | null;
}

function limitName(window: StatusBarRateLimitWindow): string {
  switch (window.kind) {
    case "weekly":
      return "weekly";
    case "monthly":
      return "monthly";
    case "period":
      return "period";
    case "session":
    case "bucket":
    case "model":
      return window.label;
  }
}

/**
 * The window that keeps a profile blocked the longest: with several limited
 * windows the profile is usable again only when the last of them resets, so
 * that is the one worth naming. A window with no reset time never beats one
 * that has it.
 */
function blockingWindow(
  segment: StatusBarProviderSegmentModel,
): StatusBarRateLimitWindow | null {
  return segment.windows
    .filter((window) => window.severity === "limited")
    .reduce<StatusBarRateLimitWindow | null>(
      (latest, window) =>
        latest === null || (window.resetsAt ?? 0) > (latest.resetsAt ?? 0)
          ? window
          : latest,
      null,
    );
}

/** In segment order, which is the user's profile order. */
export function limitedProfiles(
  cluster: StatusBarRateLimitCluster,
): ReadonlyArray<LimitedProfile> {
  if (cluster.kind !== "segments") return [];
  return cluster.segments.flatMap((segment) => {
    const window = blockingWindow(segment);
    return window === null
      ? []
      : [
          {
            providerId: segment.providerId,
            profileId: segment.profileId,
            name:
              segment.account === null
                ? providerDisplayName(segment.providerId)
                : segment.account.label,
            limitName: limitName(window),
            resetsAt: window.resetsAt,
          },
        ];
  });
}

/** `Fri, Oct 9, 2:00 PM`. `hour12` is explicit so AM/PM always renders. */
function formatBannerReset(resetsAt: number): string {
  return new Date(resetsAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** `pro20x hit its weekly limit · Resets Fri, Oct 9, 2:00 PM`. */
export function limitedProfileBannerText(profile: LimitedProfile): string {
  const sentence = `${profile.name} hit its ${profile.limitName} limit`;
  return profile.resetsAt === null
    ? sentence
    : `${sentence} · Resets ${formatBannerReset(profile.resetsAt)}`;
}
