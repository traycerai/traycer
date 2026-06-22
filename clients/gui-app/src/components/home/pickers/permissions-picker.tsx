import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NarrowOnlyTooltip } from "@/components/home/toolbar/narrow-only-tooltip";
import { ToolbarPillButton } from "@/components/home/toolbar/toolbar-buttons";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import {
  PERMISSION_OPTIONS,
  findPermissionLabel,
  findPermissionOption,
  isPermissionMode,
  normalizePermissionMode,
  type PermissionMode,
} from "@/components/home/data/landing-options";

interface PermissionsPickerProps {
  value: PermissionMode;
  disabled: boolean;
  onChange: (next: PermissionMode) => void;
  /**
   * Permission modes the active harness honors. Items not in this list render
   * disabled with an "unsupported" hint so users can't pick a mode the harness
   * silently ignores (Cursor, for example, currently runs only in
   * "full_access"). `null` means "no harness scope" - every option stays
   * enabled (used by the Settings default-permission row and during catalog
   * load).
   */
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  /**
   * Display name of the active harness, used in the "Not supported by <name>"
   * copy on disabled options. `null` falls back to the generic "this provider"
   * (catalog still loading, or harness-agnostic surfaces like the Settings
   * default-permission row).
   */
  harnessLabel: string | null;
}

export function PermissionsPicker(props: PermissionsPickerProps) {
  const { value, disabled, onChange, supportedPermissionModes, harnessLabel } =
    props;
  const unsupportedSuffix = harnessLabel ?? "this provider";
  // Display value is the *normalized* one: when the sticky value isn't in the
  // active harness's supported set (rehydration of a saved chat, the one-frame
  // window between a harness swap and the parent's clamp commit, or any race
  // where parent state lags the catalog), the trigger pill + radio's checked
  // indicator track the mode the harness will actually run, not the stale
  // sticky. The parent still owns the persisted state and may clamp on
  // user-intent harness swaps; the picker is responsible for never lying
  // about the effective permission, regardless of when the parent commits.
  const displayValue = normalizePermissionMode(value, supportedPermissionModes);
  const Icon = findPermissionOption(displayValue).icon;
  const label = findPermissionLabel(displayValue);

  return (
    <DropdownMenu>
      <NarrowOnlyTooltip label={label}>
        <DropdownMenuTrigger asChild>
          <ToolbarPillButton
            aria-label={label}
            title={label}
            disabled={disabled}
            className="max-w-[min(32cqw,13rem)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap @max-lg:hidden">
              {label}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground @max-lg:hidden" />
          </ToolbarPillButton>
        </DropdownMenuTrigger>
      </NarrowOnlyTooltip>
      <DropdownMenuContent
        align="start"
        className="min-w-[min(90vw,20rem)] p-1.5"
        // Return focus to the composer editor instead of the trigger pill so
        // the user can keep typing after picking a mode. Without this Radix
        // restores focus to the trigger, leaving the caret out of the textbox.
        onCloseAutoFocus={(event) => {
          if (focusActiveComposer()) event.preventDefault();
        }}
      >
        <DropdownMenuRadioGroup
          value={displayValue}
          onValueChange={(next) => {
            if (disabled) return;
            if (!isPermissionMode(next)) return;
            // Defense-in-depth: Radix's disabled RadioItem already blocks
            // click/keyboard activation, but a programmatic dispatch or future
            // primitive change could still call us with an unsupported mode.
            // Treat empty `supportedPermissionModes` identically to `null` -
            // see `normalizePermissionMode` for the matching semantics.
            if (
              supportedPermissionModes !== null &&
              supportedPermissionModes.length > 0 &&
              !supportedPermissionModes.includes(next)
            ) {
              return;
            }
            onChange(next);
          }}
        >
          {PERMISSION_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            const isSupported =
              supportedPermissionModes === null ||
              supportedPermissionModes.length === 0 ||
              supportedPermissionModes.includes(option.id);
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={!isSupported}
                // No `title=` here: Radix applies `data-disabled:pointer-events-none`
                // on the dropdown-menu primitive (see ui/dropdown-menu.tsx) so a
                // native browser tooltip would never fire on hover anyway. The
                // unsupported reason is rendered inline in the item body below.
                className="items-start gap-2 py-2 pr-8 pl-2 data-[state=checked]:bg-accent/70"
              >
                <OptionIcon className="mt-0.5 size-4 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium leading-5 text-foreground">
                    {option.label}
                  </span>
                  <span className="block leading-5 text-muted-foreground">
                    {isSupported
                      ? option.description
                      : `Not supported by ${unsupportedSuffix}.`}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
