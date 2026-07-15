import { useMemo, useState, type RefObject } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import {
  projectComparisonEntry,
  scopeProfileUsageRefreshStatus,
  type ProfileDropdownUsageEntry,
  type ProfileDropdownUsagePresentation,
} from "@/components/providers/profile-dropdown-usage";
import { useProfileUsageComparison } from "@/hooks/rate-limits/use-profile-usage-comparison";
import { useSampledNow } from "@/lib/relative-time";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";

interface PickerProfileDropdownProps {
  readonly providerId: GuiHarnessId;
  readonly providerLabel: string;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly activeProfileId: string | null;
  readonly onSelectProfile: (profileId: string | null) => void;
  readonly onCreateProfile: () => void;
  readonly createProfileDisabled: boolean;
  readonly createProfileDisabledReason: string | undefined;
  readonly shortcutHintForIndex: (
    index: number,
  ) => ProfileDropdownShortcutHint | null;
  readonly contentContainer: HTMLElement | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly runTargetHostId: string | null;
}

/** Picker-only opt-in boundary: Settings never mounts this component. */
export function PickerProfileDropdown(props: PickerProfileDropdownProps) {
  const providerId = guiHarnessIdToProviderId(props.providerId);
  if (providerId === null) {
    return <PickerProfileDropdownView props={props} usagePresentation={null} />;
  }
  return (
    <ProfileUsagePickerProfileDropdown props={props} providerId={providerId} />
  );
}

function ProfileUsagePickerProfileDropdown({
  props,
  providerId,
}: {
  readonly props: PickerProfileDropdownProps;
  readonly providerId: ProviderId;
}) {
  const comparison = useProfileUsageComparison({
    runTargetHostId: props.runTargetHostId,
    providerId,
    profiles: props.profiles,
  });
  const now = useSampledNow();
  const [pendingRefreshKeys, setPendingRefreshKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const entries = useMemo(() => {
    const projected = new Map<string | null, ProfileDropdownUsageEntry>();
    comparison.entries.forEach((entry, profileId) => {
      const refreshKey = JSON.stringify([providerId, profileId]);
      const refresh = async (): Promise<void> => {
        setPendingRefreshKeys((current) => {
          const next = new Set(current);
          next.add(refreshKey);
          return next;
        });
        await entry.refresh().finally(() => {
          setPendingRefreshKeys((current) => {
            if (!current.has(refreshKey)) return current;
            const next = new Set(current);
            next.delete(refreshKey);
            return next;
          });
        });
      };
      projected.set(
        profileId,
        projectComparisonEntry(
          {
            ...entry,
            refreshStatus: scopeProfileUsageRefreshStatus(
              entry.refreshStatus,
              pendingRefreshKeys.has(refreshKey),
            ),
            refresh,
          },
          now,
        ),
      );
    });
    return projected;
  }, [comparison.entries, now, pendingRefreshKeys, providerId]);
  const usagePresentation = useMemo<ProfileDropdownUsagePresentation>(
    () => ({ isHostReady: comparison.isReady, entries }),
    [comparison.isReady, entries],
  );

  return (
    <PickerProfileDropdownView
      props={props}
      usagePresentation={usagePresentation}
    />
  );
}

function PickerProfileDropdownView({
  props,
  usagePresentation,
}: {
  readonly props: PickerProfileDropdownProps;
  readonly usagePresentation: ProfileDropdownUsagePresentation | null;
}) {
  return (
    <ProfileDropdown
      providerLabel={props.providerLabel}
      profiles={props.profiles}
      activeProfileId={props.activeProfileId}
      onSelectProfile={props.onSelectProfile}
      onCreateProfile={props.onCreateProfile}
      createProfileDisabled={props.createProfileDisabled}
      createProfileDisabledReason={props.createProfileDisabledReason}
      shortcutHintForIndex={props.shortcutHintForIndex}
      contentContainer={props.contentContainer}
      onCloseAutoFocus={() => props.inputRef.current?.focus()}
      usagePresentation={usagePresentation}
    />
  );
}
