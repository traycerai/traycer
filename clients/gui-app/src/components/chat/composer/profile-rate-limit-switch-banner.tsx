import { AlertTriangle, X } from "lucide-react";
import type { ReactNode } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import type {
  ProfileRateLimitAlternative,
  ProfileRateLimitProfileChip,
} from "./use-profile-rate-limit-switch-prompt";

interface ProfileRateLimitSwitchBannerProps {
  readonly harnessId: GuiHarnessId;
  readonly hardLimited: boolean;
  /** The limited profile being switched away from - always non-null when the
   *  banner mounts (`useProfileRateLimitSwitchPrompt` only sets `limited` once
   *  `current` is resolved). */
  readonly current: ProfileRateLimitProfileChip | null;
  readonly alternatives: ReadonlyArray<ProfileRateLimitAlternative>;
  /** User-confirmed only - never called automatically. Commits the picked
   *  profile to the composer for the NEXT turn (turn-boundary switch). */
  readonly onSwitchProfile: (profileId: string | null) => void;
  /** Chats in this task the limited profile pins (this chat included). When
   *  > 1 the banner offers a second, task-wide switch option. */
  readonly affectedChatCount: number;
  /** Task-wide companion of `onSwitchProfile`: switches the OTHER affected
   *  chats of this task to the picked profile. Only invoked when the user
   *  picks the explicit task-wide option - never automatically. */
  readonly onSwitchProfileForTask: (profileId: string | null) => void;
  readonly onDismiss: () => void;
}

/**
 * Mid-chat "Continue this session on <profile>" prompt for a profile that has hit its
 * rate limit (multi-profile decision log's "Rate-limit moment"). Purely a
 * confirm-first affordance - no automatic switching or rotation anywhere.
 * Mounted/unmounted by `useProfileRateLimitSwitchPrompt`, which already
 * gates on the current profile being limited AND a viable alternative
 * existing, so this component only ever renders with >=1 alternative. Source
 * and destination both render as full icon + dot + label chips (Core Flows'
 * cross-flow identity rule: color never stands alone).
 */
export function ProfileRateLimitSwitchBanner({
  harnessId,
  hardLimited,
  current,
  alternatives,
  onSwitchProfile,
  affectedChatCount,
  onSwitchProfileForTask,
  onDismiss,
}: ProfileRateLimitSwitchBannerProps) {
  // The task-wide option includes this chat: the composer commit covers this
  // session and the task callback moves the sibling chats.
  const handleSwitchTask = (profileId: string | null): void => {
    onSwitchProfile(profileId);
    onSwitchProfileForTask(profileId);
  };
  const renderAlternativeButton = (
    alternative: ProfileRateLimitAlternative,
    label: string,
    onClick: (profileId: string | null) => void,
  ): ReactNode => (
    <Button
      key={alternative.accentDotId}
      size="sm"
      variant="secondary"
      className="gap-1.5"
      onClick={() => onClick(alternative.profileId)}
    >
      {label}{" "}
      <ProfileRateLimitChip harnessId={harnessId} profile={alternative} />
    </Button>
  );
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-foreground/90">
              {current !== null ? (
                <ProfileRateLimitChip harnessId={harnessId} profile={current} />
              ) : null}
              <span>
                {hardLimited
                  ? "has hit its rate limit."
                  : "is close to its rate limit."}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {alternatives.map((alternative) =>
                renderAlternativeButton(
                  alternative,
                  "Continue this session on",
                  onSwitchProfile,
                ),
              )}
            </div>
            {affectedChatCount > 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                {alternatives.map((alternative) =>
                  renderAlternativeButton(
                    alternative,
                    `Switch all ${affectedChatCount} chats in this task to`,
                    handleSwitchTask,
                  ),
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Dismiss rate limit suggestion"
            className="rounded p-0.5 text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={onDismiss}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileRateLimitChip({
  harnessId,
  profile,
}: {
  readonly harnessId: GuiHarnessId;
  readonly profile: ProfileRateLimitProfileChip;
}): ReactNode {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-ui-xs font-medium text-foreground">
      <HarnessIcon harnessId={harnessId} className="size-3" />
      <AccentDot
        profileId={profile.accentDotId}
        accentColor={profile.accentColor}
        label={null}
        variant="inline"
        size="default"
        className={undefined}
      />
      <span className="min-w-0 truncate">{profile.label}</span>
    </span>
  );
}
