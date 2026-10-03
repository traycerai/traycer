import { LazyDropdownMenu } from "@/components/ui/lazy-menu";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { useRef } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { NarrowOnlyTooltip } from "@/components/home/toolbar/narrow-only-tooltip";
import { ToolbarPillButton } from "@/components/home/toolbar/toolbar-buttons";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Badge } from "@/components/ui/badge";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { cn } from "@/lib/utils";
import { useRegionValue } from "@/lib/layout-overrides";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { useComposerTileId } from "@/components/home/composer/composer-tile-hooks";
import {
  AUTO_JUDGE_UNAVAILABLE_DESCRIPTION,
  AUTO_MID_TURN_NOTICE,
  PERMISSION_PICKER_OPTIONS,
  findPermissionLabel,
  findPermissionOption,
  isPermissionMode,
  composerOffersPermissionMode,
  normalizePermissionMode,
  unsupportedPermissionModeCopy,
  type PermissionMode,
} from "@/components/home/data/landing-options";
import {
  autoModeMidTurnLock,
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
   * The active judge determines whether Auto can be selected mid-turn.
   * `null` means that the judge is still unknown; see `autoModeMidTurnLock`.
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
  /** `false` for every mount that isn't a real toolbar slot (the Settings
   *  default-permission row): keeps that row from registering the
   *  `composer.access` hotspot under the shared `"landing"` tile id. */
  readonly interactive: boolean;
  /**
   * The trailing "Permission settings…" item's action, or `null` to render no
   * such item. A composer passes one (it always has a run-target host); the
   * Settings default-mode row passes `null`, because a Settings surface must
   * not open Settings.
   */
  onOpenPermissionSettings: (() => void) | null;
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
    interactive,
    onOpenPermissionSettings,
  } = props;
  // Set by the trailing Settings item for the close it causes. That close must
  // not hand focus back to the composer: the composer registry can name an
  // editor in another tab, and restoring focus there would pull that tab over
  // the Settings surface this item just opened.
  const openingSettingsRef = useRef(false);
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
  const experimental = displayValue === "auto";
  const accessibleLabel = experimental ? `${label} — Experimental` : label;
  // The Auto row's mid-turn lock, when the run's own provider would review:
  // see `autoModeMidTurnLock`. Read once, for the guard and the row alike.
  const autoMidTurnLock = autoModeMidTurnLock({
    turnActive,
    currentModeIsAuto: displayValue === "auto",
    judgeBilling,
  });
  // Layout ▸ Composer's floor for this picker, never `hidden`: the pill reports
  // the permission the next send will run under, so `compact` takes it to the
  // shape a narrow composer already puts it in - icon alone, name on hover -
  // and no further.
  const compact = useRegionValue("access", "size") === "chip";
  const tileId = useComposerTileId();
  const { ref: hotspotRef } = useLayoutRegion({
    regionId: "access",
    instanceId: tileId,
  });

  // No tooltip of its own: the wrapper below already renders one (both branches
  // ARE a `TooltipWrapper`), and the label is VISIBLE on this pill until the
  // composer goes narrow - which is exactly when that wrapper takes over. A
  // second wrapper here put two tooltips carrying the same text on one trigger,
  // and its guard span sat between `DropdownMenuTrigger asChild` and the
  // button, so Radix's menu props - `aria-haspopup`, `aria-expanded`,
  // `data-state`, the ref - landed on a generic span instead of the focusable
  // control.
  const trigger = (
    <PermissionsTrigger
      ref={interactive ? hotspotRef : undefined}
      label={label}
      aria-label={accessibleLabel}
      disabled={disabled}
      compact={compact}
      experimental={experimental}
      icon={<Icon className="size-4 shrink-0" />}
    />
  );

  return (
    <LazyDropdownMenu
      trigger={
        compact ? (
          <TooltipWrapper
            label={accessibleLabel}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            {trigger}
          </TooltipWrapper>
        ) : (
          <NarrowOnlyTooltip label={accessibleLabel}>
            {trigger}
          </NarrowOnlyTooltip>
        )
      }
    >
      <DropdownMenuContent
        align="start"
        className="min-w-[min(90vw,20rem)]"
        // Return focus to the composer editor instead of the trigger pill so
        // the user can keep typing after picking a mode. Without this Radix
        // restores focus to the trigger, leaving the caret out of the textbox.
        // A `"trigger"` caller keeps Radix's own restore (see `closeFocus`).
        onCloseAutoFocus={(event) => {
          if (openingSettingsRef.current) {
            openingSettingsRef.current = false;
            event.preventDefault();
            return;
          }
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
            // The same defense for the mid-turn lock: the host refuses this
            // flip anyway, and a refusal is a toast after the fact.
            if (next === "auto" && autoMidTurnLock !== null) return;
            onChange(next);
          }}
        >
          {PERMISSION_PICKER_OPTIONS.map((option) => {
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
            // Supported, but not for THIS turn: the row shows the lock's own
            // sentence in place of its description, without a contradictory
            // "switches now" notice.
            const lockedMidTurn =
              isSupported && option.id === "auto" && autoMidTurnLock !== null;
            let description: string;
            if (!isSupported) {
              description = unsupportedPermissionModeCopy({
                mode: option.id,
                harnessLabel,
                catalogSupportedModes,
                hostKnowsAutoMode,
              });
            } else if (lockedMidTurn) {
              description = autoMidTurnLock;
            } else if (
              option.id === "auto" &&
              judgeBilling?.kind === "blocked"
            ) {
              description = AUTO_JUDGE_UNAVAILABLE_DESCRIPTION;
            } else {
              description = option.description;
            }
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={!isSupported || lockedMidTurn}
                // No `title=` here: Radix applies `data-disabled:pointer-events-none`
                // on the dropdown-menu primitive (see ui/dropdown-menu.tsx) so a
                // native browser tooltip would never fire on hover anyway. The
                // unsupported reason is rendered inline in the item body below.
                className="items-start gap-2"
              >
                <OptionIcon className="mt-0.5 size-4 text-muted-foreground" />
                <PermissionOptionBody
                  label={option.label}
                  experimental={option.id === "auto"}
                  description={description}
                  notice={
                    isSupported &&
                    !lockedMidTurn &&
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
        {onOpenPermissionSettings !== null ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                openingSettingsRef.current = true;
                onOpenPermissionSettings();
              }}
            >
              Permission settings…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </LazyDropdownMenu>
  );
}

/** One option's label and description, plus any mid-turn switching notice. */
function PermissionOptionBody(props: {
  readonly label: string;
  readonly experimental: boolean;
  readonly description: string;
  readonly notice: string | null;
}) {
  return (
    <span className="min-w-0">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium leading-5 text-foreground">
          {props.label}
        </span>
        {props.experimental ? (
          <Badge variant="muted" size="xs">
            Experimental
          </Badge>
        ) : null}
      </span>
      <span className="block leading-5 text-muted-foreground">
        {props.description}
      </span>
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

export function PermissionsTrigger({
  label,
  disabled,
  compact,
  experimental,
  icon,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  compact: boolean;
  experimental?: boolean;
  icon: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <ToolbarPillButton
      aria-label={label}
      {...rest}
      disabled={disabled}
      // Shield alone means a SQUARE chip, not a pill with its label removed:
      // the label and chevron are `hidden` in both of these cases, so keeping
      // the pill's side padding would leave a 34px box beside the model chip's
      // 28px one. `@max-lg` is the composer going narrow, `compact` is the
      // user choosing the chip size in Layout; they arrive at the same shape.
      className={cn(
        "min-w-0",
        experimental ? "max-w-full" : "max-w-[min(32cqw,13rem)]",
        "@max-lg:size-7 @max-lg:justify-center @max-lg:px-0",
        compact && "size-7 justify-center px-0",
      )}
    >
      {icon}
      <span
        className={cn(
          "min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap @max-lg:hidden",
          compact ? "hidden" : "inline-flex",
        )}
      >
        <span className="truncate">{label}</span>
        {experimental ? (
          <Badge variant="muted" size="xs">
            Experimental
          </Badge>
        ) : null}
      </span>
      <ChevronDown
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground @max-lg:hidden",
          compact && "hidden",
        )}
      />
    </ToolbarPillButton>
  );
}
