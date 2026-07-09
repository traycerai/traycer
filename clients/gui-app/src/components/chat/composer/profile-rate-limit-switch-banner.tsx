import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProfileRateLimitAlternative } from "./use-profile-rate-limit-switch-prompt";

interface ProfileRateLimitSwitchBannerProps {
  readonly hardLimited: boolean;
  readonly alternatives: ReadonlyArray<ProfileRateLimitAlternative>;
  /** User-confirmed only - never called automatically. Commits the picked
   *  profile to the composer for the NEXT turn (turn-boundary switch). */
  readonly onSwitchProfile: (profileId: string | null) => void;
}

/**
 * Mid-chat "Continue this session on <profile>" prompt for a profile that has hit its
 * rate limit (multi-profile decision log's "Rate-limit moment"). Purely a
 * confirm-first affordance - no automatic switching or rotation anywhere.
 * Mounted/unmounted by `useProfileRateLimitSwitchPrompt`, which already
 * gates on the current profile being limited AND a viable alternative
 * existing, so this component only ever renders with >=1 alternative.
 */
export function ProfileRateLimitSwitchBanner({
  hardLimited,
  alternatives,
  onSwitchProfile,
}: ProfileRateLimitSwitchBannerProps) {
  return (
    <div className="mb-3 flex w-full flex-col gap-1.5">
      <div className="flex w-full flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-foreground/90">
              {hardLimited
                ? "This profile has hit its rate limit."
                : "This profile is close to its rate limit."}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {alternatives.map((alternative) => (
                <Button
                  key={alternative.label}
                  size="sm"
                  variant="secondary"
                  onClick={() => onSwitchProfile(alternative.profileId)}
                >
                  Continue this session on {alternative.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
