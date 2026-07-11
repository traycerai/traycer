import { CheckIcon, ChevronDown, Pencil, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  profileCommitId,
  profileDisplayLabel,
  profileRowStatusSuffix,
} from "@/components/providers/provider-profile-model";
import { cn } from "@/lib/utils";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

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
  /** Settings-only edit action. When present, it is visually inset into the
   *  trigger immediately before the caret without nesting one button inside
   *  another. Picker surfaces pass null. */
  readonly onEditProfile: (() => void) | null;
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
    onEditProfile,
    createProfileDisabled,
    createProfileDisabledReason,
    shortcutHintForIndex,
    contentContainer,
    onCloseAutoFocus,
  } = props;
  const activeProfile =
    profiles.find((profile) => profileCommitId(profile) === activeProfileId) ??
    profiles[0];

  return (
    <DropdownMenu modal={false}>
      {onEditProfile === null ? (
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
      ) : (
        <div className="relative h-8 min-w-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${providerLabel} profile: ${profileDisplayLabel(activeProfile)}`}
              className="absolute inset-0 rounded-md border border-input bg-transparent text-foreground outline-none transition-colors hover:bg-input/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-open:bg-input/30 dark:bg-input/30 dark:hover:bg-input/50"
            >
              <span className="sr-only">
                Select {profileDisplayLabel(activeProfile)} profile
              </span>
            </button>
          </DropdownMenuTrigger>
          <div className="pointer-events-none relative flex h-full min-w-0 items-center gap-2 px-2.5 text-ui-sm text-foreground">
            <AccentDot
              profileId={activeProfile.profileId}
              accentColor={activeProfile.accentColor}
              label={null}
              variant="inline"
              size="default"
              className={undefined}
            />
            <span
              aria-hidden="true"
              className="min-w-0 truncate text-left font-medium"
            >
              {profileDisplayLabel(activeProfile)}
            </span>
            <button
              type="button"
              aria-label={`Edit ${profileDisplayLabel(activeProfile)} profile`}
              className="pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={onEditProfile}
            >
              <Pencil className="size-3.5" />
            </button>
            <span className="min-w-0 flex-1" />
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          </div>
        </div>
      )}
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
      >
        {profiles.map((profile, index) => {
          const statusSuffix = profileRowStatusSuffix(profile);
          const commitId = profileCommitId(profile);
          const label = profileDisplayLabel(profile);
          const shortcutHint = shortcutHintForIndex(index);
          return (
            <DropdownMenuItem
              key={profile.profileId}
              aria-label={
                statusSuffix === null ? label : `${label}, ${statusSuffix}`
              }
              aria-current={commitId === activeProfileId ? "true" : undefined}
              className={cn("pr-1.5", statusSuffix !== null && "opacity-60")}
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
              {shortcutHint !== null ? (
                <DropdownMenuShortcut
                  data-testid={`model-profile-digit-${shortcutHint.digit}`}
                >
                  {shortcutHint.label}
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
    </DropdownMenu>
  );
}
