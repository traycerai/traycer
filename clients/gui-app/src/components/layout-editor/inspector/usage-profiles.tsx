import { useId, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { useLayoutUsage } from "@/components/layout-editor/inspector/use-layout-usage";
import {
  OrderGroupHeader,
  OrderGroupList,
} from "@/components/layout-editor/inspector/rows/order-group-list";
import {
  BARE_ROW,
  type SortableRowDecoration,
} from "@/components/layout-editor/inspector/rows/order-row-items";
import { useSortableRowPadding } from "@/components/layout-editor/inspector/sortable-row-padding";
import { RowAvailabilityLine } from "@/components/layout-editor/inspector/rows/row-availability-line";
import {
  disabledBy,
  type LayoutFormContext,
} from "@/components/layout-editor/regions/row-availability";
import { toggleHiddenProvider } from "@/components/layout-editor/layout-gestures";
import { AccentDot } from "@/components/providers/accent-dot";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { Button } from "@/components/ui/button";
import { resolveStatusBarProfileIds } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  DEFAULT_ARRANGEMENT,
  withShownProfileIds,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { reorderedGroups } from "@/lib/layout/layout-diff";
import type { LayoutValues } from "@/lib/layout/layout-values";
import { providerDisplayName } from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { cn } from "@/lib/utils";

/**
 * One list for the profiles the usage readings draw, grouped by provider:
 * drag a provider to order it, an eye on a provider hides it (`hiddenProviders`)
 * and an eye on a profile shows or hides that account on the watched host
 * (`shownProfiles`). The popover keeps every profile, hidden or not.
 *
 * A provider with a single profile has nothing to choose between, so its row
 * has no profiles under it.
 */
export function UsageProfilesList(props: {
  readonly arrangement: LayoutArrangement;
  readonly values: LayoutValues;
  readonly context: LayoutFormContext;
}): ReactNode {
  const { arrangement, values, context } = props;
  const usage = useLayoutUsage();
  // The providers whose profiles are folded away; open is the default.
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>([]);
  const gutter = useSortableRowPadding();

  function decorate(id: string): SortableRowDecoration {
    const providerId = arrangement.usageProviders.find((entry) => entry === id);
    if (providerId === undefined) return BARE_ROW;
    const name = providerDisplayName(providerId);
    const profiles = usage.profilesByProvider[providerId] ?? [];
    const shown = !arrangement.hiddenProviders.includes(providerId);
    const hasProfiles = profiles.length > 1;
    return {
      ...BARE_ROW,
      control: (
        <EyeButton
          label={`${shown ? "Hide" : "Show"} ${name}`}
          shown={shown}
          disabled={false}
          describedBy={null}
          onToggle={() => {
            toggleHiddenProvider(providerId, arrangement, !shown);
          }}
        />
      ),
      revert: shown ? null : (
        <RevertButton
          label={`Revert ${name}`}
          onRevert={() => {
            toggleHiddenProvider(providerId, arrangement, true);
          }}
        />
      ),
      detail: hasProfiles ? (
        <ProviderProfileRows
          providerId={providerId}
          profiles={profiles}
          arrangement={arrangement}
        />
      ) : null,
      open: hasProfiles && !collapsed.includes(id),
      onToggleOpen: hasProfiles
        ? () => {
            setCollapsed(
              collapsed.includes(id)
                ? collapsed.filter((entry) => entry !== id)
                : [...collapsed, id],
            );
          }
        : null,
    };
  }

  return (
    <div className="flex flex-col" data-usage-profiles>
      <div className={cn("border-b border-border/40", gutter.row)}>
        <OrderGroupHeader
          group="usageProviders"
          revert={
            reorderedGroups(arrangement).includes("usageProviders") ? (
              <RevertButton
                label="Revert Profiles order"
                onRevert={() => {
                  writeArrangement({
                    ...arrangement,
                    usageProviders: DEFAULT_ARRANGEMENT.usageProviders,
                  });
                }}
              />
            ) : null
          }
        />
      </div>
      <OrderGroupList
        group="usageProviders"
        selectedId={null}
        values={values}
        arrangement={arrangement}
        decorate={decorate}
        context={context}
      />
    </div>
  );
}

/** Why the last profile drawn has no Hide (U5). */
const LAST_PROFILE_REASON =
  "One profile stays shown. Hide the provider instead.";

/** One provider's profiles, each with its own eye for the watched host. */
function ProviderProfileRows(props: {
  readonly providerId: RateLimitProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { providerId, profiles, arrangement } = props;
  const { hostId, profileSelection } = useLayoutUsage();
  const gutter = useSortableRowPadding();
  const listId = useId();
  const drawn = resolveStatusBarProfileIds(
    profileSelection,
    providerId,
    profiles,
  );
  return (
    <ul aria-label={`${providerDisplayName(providerId)} profiles`}>
      {profiles.map((profile) => {
        const profileId = profileCommitId(profile);
        const shown = drawn.includes(profileId);
        // The last account drawn stays: a provider that draws nothing is what
        // the provider's own eye is for, and the row says so.
        const last = shown && drawn.length <= 1;
        const reasonId = `${listId}-${profile.profileId}`;
        return (
          <li
            key={profile.profileId}
            data-profile-row={profile.profileId}
            className={cn(
              "flex items-center gap-2 border-t border-border/40",
              gutter.row,
              !shown && "text-muted-foreground",
            )}
          >
            <span aria-hidden className="w-7 shrink-0" />
            {/* Top-aligned as a form row's label block is, so the dot stays on
              the name's line when the reason wraps under it. */}
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <span className="flex h-lh shrink-0 items-center">
                <AccentDot
                  profileId={profile.profileId}
                  accentColor={profile.accentColor}
                  label={null}
                  variant="inline"
                  size="default"
                  className={undefined}
                />
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate">{profile.label}</span>
                {last ? (
                  <RowAvailabilityLine
                    id={reasonId}
                    availability={disabledBy(LAST_PROFILE_REASON, null)}
                    layoutClassName={null}
                  />
                ) : null}
              </div>
            </div>
            <EyeButton
              label={`${shown ? "Hide" : "Show"} ${profile.label}`}
              shown={shown}
              disabled={hostId === null || last}
              describedBy={last ? reasonId : null}
              onToggle={() => {
                if (hostId === null) return;
                writeArrangement({
                  ...arrangement,
                  shownProfiles: withShownProfileIds(
                    arrangement.shownProfiles,
                    hostId,
                    providerId,
                    shown
                      ? drawn.filter((entry) => entry !== profileId)
                      : [...drawn, profileId],
                  ),
                });
              }}
            />
            <span aria-hidden className="size-3.5 shrink-0" />
          </li>
        );
      })}
    </ul>
  );
}

function EyeButton(props: {
  readonly label: string;
  readonly shown: boolean;
  readonly disabled: boolean;
  /** The reason a disabled eye gives, or `null`. */
  readonly describedBy: string | null;
  readonly onToggle: () => void;
}): ReactNode {
  const { label, shown, disabled, onToggle } = props;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-describedby={props.describedBy ?? undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {shown ? <Eye /> : <EyeOff />}
    </Button>
  );
}
