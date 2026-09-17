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
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/settings/layout-store";
import {
  AUTO_MID_TURN_NOTICE,
  PERMISSION_OPTIONS,
  findPermissionLabel,
  findPermissionOption,
  isPermissionMode,
  composerOffersPermissionMode,
  normalizePermissionMode,
  unsupportedPermissionModeCopy,
  type PermissionMode,
} from "@/components/home/data/landing-options";
import {
  autoJudgeMetaLine,
  type AutoJudgeBilling,
} from "@/lib/auto-mode/auto-judge-billing";

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
  /**
   * Every permission mode ANY harness in this host's catalog honors - the
   * union, not one row's set. It is what tells a HOST constraint from a
   * PROVIDER one on a disabled option: a mode absent from every row means the
   * host predates it, which is a different sentence and a different fix.
   *
   * `null` (catalog still loading, or a harness-agnostic surface) keeps
   * today's provider-blaming string, so nothing accuses the host on a fact not
   * yet in evidence. See `unsupportedPermissionModeCopy`.
   */
  catalogSupportedModes: ReadonlyArray<PermissionMode> | null;
  /** Whether the host's catalog LINE can spell `auto` - vetoes the upgrade
   *  sentence in `unsupportedPermissionModeCopy`. */
  hostKnowsAutoMode: boolean | null;
  /**
   * Whether a turn is running on this composer's chat right now. Drives the
   * `auto` row's mid-turn notice only; `false` is every surface with no turn
   * to speak of (the landing composer, the Settings default-permission row).
   */
  turnActive: boolean;
  /**
   * Which pocket this host's judge is charged to, for the `auto` row's meta
   * line. `null` - still loading, or a host that has no notion of a judge -
   * renders no meta line at all, which is exactly today's behaviour.
   */
  judgeBilling: AutoJudgeBilling | null;
  /**
   * Where focus lands when the menu closes.
   *
   * `"composer"` hands it back to the composer editor so the user can keep
   * typing - the whole reason this control sits in a composer toolbar. A
   * SETTINGS row must pass `"trigger"`: the composer registry is app-global and
   * its inactive fallback can name an editor on a canvas behind the settings
   * surface, so closing this menu there would pull focus (and the tab it lives
   * in) out from under the panel the user is reading.
   */
  closeFocus: "composer" | "trigger";
}

export function PermissionsPicker(props: PermissionsPickerProps) {
  const {
    value,
    disabled,
    onChange,
    supportedPermissionModes,
    harnessLabel,
    catalogSupportedModes,
    hostKnowsAutoMode,
    turnActive,
    judgeBilling,
    closeFocus,
  } = props;
  // Display value is the *normalized* one: when the sticky value isn't in the
  // active harness's supported set (rehydration of a saved chat, the one-frame
  // window between a harness swap and the parent's clamp commit, or any race
  // where parent state lags the catalog), the trigger pill + radio's checked
  // indicator track the mode the harness will actually run, not the stale
  // sticky. The parent still owns the persisted state and may clamp on
  // user-intent harness swaps; the picker is responsible for never lying
  // about the effective permission, regardless of when the parent commits.
  const displayValue = normalizePermissionMode(
    value,
    supportedPermissionModes,
    hostKnowsAutoMode,
  );
  const Icon = findPermissionOption(displayValue).icon;
  const label = findPermissionLabel(displayValue);
  // Layout ▸ Composer's floor for this picker, never `hidden`: the pill reports
  // the permission the next send will run under, so `compact` takes it to the
  // shape a narrow composer already puts it in - icon alone, name on hover -
  // and no further.
  const compact = useLayoutStore((s) => s.composer.access) === "compact";

  // No tooltip of its own: the wrapper below already renders one (both branches
  // ARE a `TooltipWrapper`), and the label is VISIBLE on this pill until the
  // composer goes narrow - which is exactly when that wrapper takes over. A
  // second wrapper here put two tooltips carrying the same text on one trigger,
  // and its guard span sat between `DropdownMenuTrigger asChild` and the
  // button, so Radix's menu props - `aria-haspopup`, `aria-expanded`,
  // `data-state`, the ref - landed on a generic span instead of the focusable
  // control.
  const trigger = (
    <DropdownMenuTrigger asChild>
      <ToolbarPillButton
        aria-label={label}
        disabled={disabled}
        className={cn(
          "max-w-[min(32cqw,13rem)] disabled:cursor-not-allowed disabled:opacity-50",
          compact && "justify-center",
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate whitespace-nowrap @max-lg:hidden",
            compact && "hidden",
          )}
        >
          {label}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground @max-lg:hidden",
            compact && "hidden",
          )}
        />
      </ToolbarPillButton>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {compact ? (
        <TooltipWrapper
          label={label}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          {trigger}
        </TooltipWrapper>
      ) : (
        <NarrowOnlyTooltip label={label}>{trigger}</NarrowOnlyTooltip>
      )}
      <DropdownMenuContent
        align="start"
        className="min-w-[min(90vw,20rem)]"
        // Return focus to the composer editor instead of the trigger pill so
        // the user can keep typing after picking a mode. Without this Radix
        // restores focus to the trigger, leaving the caret out of the textbox.
        // A `"trigger"` caller keeps Radix's own restore (see `closeFocus`).
        onCloseAutoFocus={(event) => {
          if (closeFocus !== "composer") return;
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
            // The ROW's constraint and the HOST's line, through the one
            // predicate that pairs them. The row alone lights `auto` up on a
            // machine that cannot spell it, because a pre-`auto` host's rows
            // are unconstrained like any other.
            const isSupported = composerOffersPermissionMode(
              supportedPermissionModes,
              option.id,
              hostKnowsAutoMode,
            );
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={!isSupported}
                // No `title=` here: Radix applies `data-disabled:pointer-events-none`
                // on the dropdown-menu primitive (see ui/dropdown-menu.tsx) so a
                // native browser tooltip would never fire on hover anyway. The
                // unsupported reason is rendered inline in the item body below.
                className="items-start gap-2"
              >
                <OptionIcon className="mt-0.5 size-4 text-muted-foreground" />
                <PermissionOptionBody
                  label={option.label}
                  description={
                    isSupported
                      ? option.description
                      : unsupportedPermissionModeCopy({
                          mode: option.id,
                          harnessLabel,
                          catalogSupportedModes,
                          hostKnowsAutoMode,
                        })
                  }
                  metaLine={
                    isSupported && option.id === "auto" && judgeBilling !== null
                      ? autoJudgeMetaLine(judgeBilling)
                      : null
                  }
                  notice={
                    isSupported &&
                    option.id === "auto" &&
                    turnActive &&
                    displayValue !== "auto"
                      ? AUTO_MID_TURN_NOTICE
                      : null
                  }
                />
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One option's text column: name, what it does, and - on `auto` only - which
 * pocket it spends and what a mid-turn switch actually does.
 *
 * Extracted so the `auto` row's two extra lines do not push the map callback
 * above the complexity ceiling; it renders nothing for `metaLine` / `notice`
 * on every other row, which is what keeps their absence the default.
 */
function PermissionOptionBody(props: {
  readonly label: string;
  readonly description: string;
  readonly metaLine: string | null;
  readonly notice: string | null;
}) {
  return (
    <span className="min-w-0">
      <span className="block font-medium leading-5 text-foreground">
        {props.label}
      </span>
      <span className="block leading-5 text-muted-foreground">
        {props.description}
      </span>
      {props.metaLine !== null ? (
        <span
          data-testid="permission-option-meta"
          className="block leading-5 text-ui-xs text-muted-foreground"
        >
          {props.metaLine}
        </span>
      ) : null}
      {props.notice !== null ? (
        <span
          data-testid="permission-option-mid-turn-notice"
          className="mt-1 block text-pretty leading-5 text-ui-xs text-muted-foreground"
        >
          {props.notice}
        </span>
      ) : null}
    </span>
  );
}
