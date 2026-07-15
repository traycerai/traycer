import { CheckIcon, ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  profileCommitId,
  profileDisplayLabel,
  profileAuthStatusText,
  profileRowStatusSuffix,
} from "@/components/providers/provider-profile-model";
import {
  profileUsageAccessibleStatus,
  type ProfileDropdownUsageEntry,
  type ProfileDropdownUsagePresentation,
} from "@/components/providers/profile-dropdown-usage";
import { ProfileUsageSidecar } from "@/components/providers/profile-usage-sidecar";
import { isProfileUsageSidecarTarget } from "@/components/providers/profile-usage-sidecar-target";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { useState } from "react";

const PROFILE_DROPDOWN_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "Enter",
  "Escape",
]);

/** A row's ⌘⇧-digit shortcut hint - `digit` drives the row's test id,
 *  `label` is the displayed chord text. Keeping both explicit (rather than
 *  deriving the digit from `label`) keeps this component free of any
 *  keybinding-formatting knowledge. */
export interface ProfileDropdownShortcutHint {
  readonly digit: string;
  readonly label: string;
}

interface ProfileDropdownProps {
  readonly providerLabel: string;
  /** 2+ selectable profiles - progressive disclosure (no dropdown under 2) is
   *  the caller's gate, not this component's. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly activeProfileId: string | null;
  readonly onSelectProfile: (profileId: string | null) => void;
  readonly onCreateProfile: () => void;
  readonly createProfileDisabled: boolean;
  readonly createProfileDisabledReason: string | undefined;
  /** Per-row shortcut hint, or a function that always returns `null` to opt
   *  out entirely. The picker wrapper supplies live ⌘⇧-digit hints (it's
   *  live-dispatchable there); Settings passes an always-null function -
   *  ⌘⇧-digit isn't wired to that surface. This component renders whatever
   *  it's given and owns no keybinding-formatting policy itself. */
  readonly shortcutHintForIndex: (
    index: number,
  ) => ProfileDropdownShortcutHint | null;
  /** Portal target for nested surfaces. The model picker passes its popover
   *  node so dropdown outside-click handling does not dismiss the whole picker;
   *  Settings passes null to keep the default document-level portal. */
  readonly contentContainer: HTMLElement | null;
  /** Non-null overrides Radix's default close-focus-return-to-trigger, e.g. so
   *  the picker can send focus back to its search input instead. Null keeps
   *  the default (Settings has no outer surface to defer to). */
  readonly onCloseAutoFocus: (() => void) | null;
  /** Picker-only cached usage presentation. Settings passes `null`, which
   *  preserves the identity-only rows and mounts no usage observers/sidecar. */
  readonly usagePresentation: ProfileDropdownUsagePresentation | null;
}

/**
 * Shared profile switcher (multi-profile UX overhaul, 2026-07-09 wireframe):
 * one compact dropdown reused by the model picker (replacing the old chip
 * strip) and Settings' profile-scoped provider section. Closed: accent dot +
 * active profile name + chevron. Open: one row per profile (dot + name +
 * status suffix for signed-out/unavailable + optional shortcut hint), then a
 * separator and a final "Create new profile" row.
 */
export function ProfileDropdown(props: ProfileDropdownProps) {
  const {
    providerLabel,
    profiles,
    activeProfileId,
    onSelectProfile,
    onCreateProfile,
    createProfileDisabled,
    createProfileDisabledReason,
    shortcutHintForIndex,
    contentContainer,
    onCloseAutoFocus,
    usagePresentation,
  } = props;
  const activeProfile =
    profiles.find((profile) => profileCommitId(profile) === activeProfileId) ??
    profiles[0];
  const activeCommitId = profileCommitId(activeProfile);
  const [open, setOpen] = useState(false);
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(
    activeCommitId,
  );
  const [previewAnchor, setPreviewAnchor] = useState<HTMLElement | null>(null);
  const previewProfile = profiles.find(
    (profile) => profileCommitId(profile) === previewProfileId,
  );
  const previewEntry = usagePresentation?.entries.get(previewProfileId);

  const preview = (profileId: string | null, anchor: HTMLElement): void => {
    setPreviewProfileId(profileId);
    setPreviewAnchor(anchor);
  };

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setPreviewAnchor(null);
          return;
        }
        setPreviewProfileId(activeCommitId);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${providerLabel} profile: ${profileDisplayLabel(activeProfile)}`}
          className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 text-ui-sm text-foreground outline-none transition-colors hover:bg-input/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-open:bg-input/30 dark:bg-input/30 dark:hover:bg-input/50"
        >
          <AccentDot
            profileId={activeProfile.profileId}
            accentColor={activeProfile.accentColor}
            label={null}
            variant="inline"
            size="default"
            className={undefined}
          />
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {profileDisplayLabel(activeProfile)}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        container={contentContainer}
        className="min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-lg p-1"
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus === null) return;
          event.preventDefault();
          onCloseAutoFocus();
        }}
        onInteractOutside={(event) => {
          if (isProfileUsageSidecarTarget(event.target)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          // Item-level navigation/selection runs before the event bubbles to
          // content. At content, Radix calls this handler before its own later
          // composed callback; stopPropagation blocks enclosing React handlers
          // without cancelling either same-target continuation.
          if (PROFILE_DROPDOWN_KEYS.has(event.key)) event.stopPropagation();
          if (
            usagePresentation === null ||
            event.key.toLowerCase() !== "r" ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          const entry = usagePresentation.entries.get(previewProfileId);
          if (
            entry === undefined ||
            entry.refreshStatus !== "idle" ||
            !usagePresentation.isHostReady
          ) {
            return;
          }
          event.preventDefault();
          void entry.refresh();
        }}
      >
        {profiles.map((profile, index) => {
          const statusSuffix = profileRowStatusSuffix(profile);
          const commitId = profileCommitId(profile);
          const label = profileDisplayLabel(profile);
          const shortcutHint = shortcutHintForIndex(index);
          const usageEntry = usagePresentation?.entries.get(commitId);
          const selected = commitId === activeProfileId;
          const accessibleLabel = profileRowAccessibleLabel({
            label,
            profile,
            selected,
            statusSuffix,
            usageEntry,
          });
          return (
            <DropdownMenuItem
              key={profile.profileId}
              ref={(node) => {
                if (commitId === previewProfileId && node !== null) {
                  setPreviewAnchor(node);
                }
              }}
              aria-label={accessibleLabel}
              aria-keyshortcuts={usageEntry === undefined ? undefined : "R"}
              aria-current={selected ? "true" : undefined}
              className={cn("pr-1.5", statusSuffix !== null && "opacity-60")}
              onFocus={(event) => preview(commitId, event.currentTarget)}
              onPointerMove={(event) => preview(commitId, event.currentTarget)}
              onSelect={() => onSelectProfile(commitId)}
            >
              <AccentDot
                profileId={profile.profileId}
                accentColor={profile.accentColor}
                label={null}
                variant="inline"
                size="default"
                className={undefined}
              />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {statusSuffix !== null ? (
                <span className="shrink-0 text-muted-foreground">
                  {statusSuffix}
                </span>
              ) : null}
              {usageEntry !== undefined ? (
                <ProfileUsageCompactMeter entry={usageEntry} />
              ) : null}
              {shortcutHint !== null ? (
                <DropdownMenuShortcut
                  data-testid={`model-profile-digit-${shortcutHint.digit}`}
                >
                  <Kbd className="font-mono tabular-nums">
                    {shortcutHint.label}
                  </Kbd>
                </DropdownMenuShortcut>
              ) : null}
              <span className="pointer-events-none flex size-4 shrink-0 items-center justify-center">
                {commitId === activeProfileId ? (
                  <CheckIcon className="size-4" />
                ) : null}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={createProfileDisabled}
          title={createProfileDisabledReason}
          onSelect={onCreateProfile}
        >
          <Plus className="size-3.5" />
          Create new profile
        </DropdownMenuItem>
      </DropdownMenuContent>
      {usagePresentation !== null &&
      open &&
      previewProfile !== undefined &&
      previewEntry !== undefined ? (
        <ProfileUsageSidecar
          anchor={previewAnchor}
          profile={previewProfile}
          entry={previewEntry}
          isHostReady={usagePresentation.isHostReady}
        />
      ) : null}
    </DropdownMenu>
  );
}

function profileRowAccessibleLabel(input: {
  readonly label: string;
  readonly profile: ProviderProfile;
  readonly selected: boolean;
  readonly statusSuffix: string | null;
  readonly usageEntry: ProfileDropdownUsageEntry | undefined;
}): string {
  if (input.usageEntry === undefined) {
    if (input.statusSuffix === null) return input.label;
    return `${input.label}, ${input.statusSuffix}`;
  }
  const selection = input.selected ? "Selected" : "Not selected";
  return `${input.label}, ${profileAuthStatusText(input.profile)}, ${selection}, ${profileUsageAccessibleStatus(input.usageEntry.projection)}`;
}

function ProfileUsageCompactMeter({
  entry,
}: {
  readonly entry: ProfileDropdownUsageEntry;
}) {
  const projection = entry.projection;
  const hasDetail = projection.kind === "detail" || projection.kind === "stale";
  const fillPercent = hasDetail
    ? rateLimitWindowFillPercent(projection.compactWindow.window.usedPercent)
    : 0;
  const severity =
    projection.kind === "detail" ||
    projection.kind === "stale" ||
    projection.kind === "semantic_only"
      ? projection.severity
      : null;
  return (
    <span
      aria-hidden="true"
      data-testid={`profile-usage-bar-${String(entry.profileId)}`}
      data-usage-kind={projection.kind}
      className={cn(
        "h-1 w-[clamp(3.5rem,22%,5.5rem)] shrink-0 overflow-hidden rounded-full bg-foreground/15",
        projection.kind === "semantic_only" &&
          projection.severity === "running_low" &&
          "bg-amber-500/25 dark:bg-amber-400/25",
        projection.kind === "semantic_only" &&
          projection.severity === "limited" &&
          "bg-red-500/25 dark:bg-red-400/25",
        (projection.kind === "stale" || projection.kind === "unavailable") &&
          "opacity-50",
      )}
    >
      {hasDetail && severity !== null ? (
        <span
          className={cn(
            "block h-full rounded-full transition-[width]",
            rateLimitWindowSeverityBarClassName(severity),
          )}
          style={{ width: `${fillPercent}%` }}
        />
      ) : null}
    </span>
  );
}
