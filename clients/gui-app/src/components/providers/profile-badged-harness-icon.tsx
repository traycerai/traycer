import type { ReactNode } from "react";
import type { ProviderId } from "@/components/home/data/landing-options";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import type { ProfileAccentDotInput } from "@/components/providers/provider-profile-model";
import { cn } from "@/lib/utils";

/**
 * Shared harness/profile identity mark for persisted runs. It keeps the
 * composer's compact bottom-right profile badge while letting each surface
 * supply the harness-icon size it already uses.
 */
export function ProfileBadgedHarnessIcon(props: {
  readonly harnessId: ProviderId;
  readonly harnessName: string;
  readonly profileAccentDot: ProfileAccentDotInput | null;
  readonly iconClassName: string;
  readonly className: string | undefined;
  readonly testId: string | undefined;
}): ReactNode {
  const accentDot = props.profileAccentDot;
  return (
    <span
      role="img"
      aria-label={
        accentDot === null
          ? props.harnessName
          : `${props.harnessName}, ${accentDot.label}`
      }
      className={cn("relative flex shrink-0 items-center", props.className)}
      data-testid={props.testId}
    >
      <HarnessIcon
        harnessId={props.harnessId}
        className={props.iconClassName}
      />
      {accentDot === null ? null : (
        <AccentDot
          profileId={accentDot.profileId}
          accentColor={accentDot.accentColor}
          label={accentDot.label}
          variant="corner"
          size="compact"
          className={undefined}
        />
      )}
    </span>
  );
}
