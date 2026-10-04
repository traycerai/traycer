import { useId, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import {
  ProviderLimitWindowsReader,
  type ProviderLimitWindows,
} from "@/components/layout-editor/inspector/provider-limit-windows";
import { SegmentedControl } from "@/components/layout-editor/inspector/segmented-control";
import type { StatusBarRateLimitWindow } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import {
  AUTOMATIC_LIMIT_SELECTION,
  isAutomaticLimitSelection,
  type LayoutArrangement,
  type StatusBarProviderLimitSelection,
} from "@/lib/layout/layout-arrangement";
import { USAGE_PROVIDER_LEVEL } from "@/components/layout-editor/regions/usage-provider-level";
import {
  disabledBy,
  LIVE,
  type RowJump,
  type ShownRowAvailability,
} from "@/components/layout-editor/regions/row-availability";
import { useRegionShown } from "@/lib/layout-overrides";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

interface ProviderLimitsProps {
  readonly providerId: RateLimitProviderId;
}

/**
 * A provider row's disclosure: `Automatic` or `Choose...` plus that provider's
 * own window checklist (L-96, L-123). The row above it already names the
 * provider and carries its `Shown | Hidden` control.
 *
 * `Choose...` opens a checklist of this provider's OWN live windows, read
 * through `ProviderLimitWindowsReader` - the strip's own read, observed
 * passively, never a query of this row's own (L-96). The dim belongs here:
 * "everything below Shown is greyed" is the same rule whichever control wrote
 * `hiddenProviders`.
 */
export function ProviderLimitsControl(props: ProviderLimitsProps): ReactNode {
  return (
    <ProviderLimitWindowsReader providerId={props.providerId}>
      {(limits) => (
        <ProviderLimitsPick providerId={props.providerId} limits={limits} />
      )}
    </ProviderLimitWindowsReader>
  );
}

/** The pick itself, over windows its caller has already read. */
function ProviderLimitsPick(props: {
  readonly providerId: RateLimitProviderId;
  readonly limits: ProviderLimitWindows;
}): ReactNode {
  const { providerId, limits } = props;
  const emptyReasonId = useId();
  const { windows, drawnKeys } = limits;
  const arrangement = useLayoutStore((state) => state.arrangement);
  const usageShown = useRegionShown("usageLimits");
  const availability = providerLimitsAvailability(
    providerId,
    usageShown,
    arrangement.hiddenProviders.includes(providerId),
  );
  const selection =
    arrangement.providerLimits[providerId] ?? AUTOMATIC_LIMIT_SELECTION;
  // The two modes are exclusive by construction: `Automatic` is an empty pick
  // list and `Choose...` is a non-empty one, so "switching back to Automatic
  // clears the picks" (L-96) is not a second rule to keep - it is the only way
  // back. With no windows the control displays Automatic, but retains stored
  // picks so they return when the watched host reports those windows again.
  const choosing = windows.length > 0 && selection.limitKeys.length > 0;
  const picked = new Set(selection.limitKeys);
  const pickingLimits = choosing;

  if (!isWindowedRateLimitProvider(providerId)) return null;

  return (
    // GREYED IN PLACE, which is what L-08 asks for and what `inert` was not
    // (R3-16): the row shell's disabled `fieldset` turns every control off
    // without hiding any of them - the mode pick's buttons and the window
    // checkboxes stop being operable by pointer OR keyboard, and each is still
    // announced, with its state and the reason, which names the Layout switch
    // that greys it and links there (U5).
    <LayoutFormRow
      anchor={null}
      icon={null}
      onRevert={null}
      revertLabel=""
      // The two options read "Automatic (recommended)" and "Choose...",
      // about 200px of a 292px content box: inline, the label column was
      // handed what was left and broke at every space (I-05). A control
      // too wide for its row goes on its own line, which is the
      // prototype's own answer for the same shape (`.srow.stacked`).
      stacked
      selected={false}
      availability={availability}
      depth={0}
      label={USAGE_PROVIDER_LEVEL.limitsLabel}
      description={USAGE_PROVIDER_LEVEL.limitsDescription}
      control={
        <div className="flex flex-col gap-2.5">
          <SegmentedControl
            ariaLabel={USAGE_PROVIDER_LEVEL.limitsLabel}
            options={USAGE_PROVIDER_LEVEL.limitsOptions.map((option) => ({
              ...option,
              disabled: option.value === "choose" && windows.length === 0,
              describedBy:
                option.value === "choose" && windows.length === 0
                  ? emptyReasonId
                  : undefined,
            }))}
            value={choosing ? "choose" : "automatic"}
            onChange={(next) => {
              if (next !== "choose") {
                writeSelection(
                  providerId,
                  arrangement,
                  AUTOMATIC_LIMIT_SELECTION,
                );
                return;
              }
              // Nothing reported yet: there is no list to open and an
              // empty pick would be a selection that draws nothing, so
              // the level stays on Automatic and says why (L-96).
              if (windows.length === 0) return;
              writeSelection(
                providerId,
                arrangement,
                chosenSelection(drawnKeys, windows),
              );
            }}
          />
          {windows.length === 0 ? (
            <p id={emptyReasonId} className="text-ui-xs text-muted-foreground">
              {USAGE_PROVIDER_LEVEL.limitsEmpty}
            </p>
          ) : null}
          {pickingLimits ? (
            <div
              role="group"
              aria-label={USAGE_PROVIDER_LEVEL.limitsPickLabel}
              className="flex flex-col gap-1.5"
            >
              {windows.map((window) => {
                const checked = picked.has(window.windowKey);
                // The last one on screen cannot be unticked: a selection
                // that draws nothing is what the Shown switch above is
                // for, and the store refuses it anyway (L-96).
                const last = checked && picked.size <= 1;
                return (
                  <label
                    key={window.windowKey}
                    className="flex items-center gap-2 text-ui-sm"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={last}
                      onCheckedChange={(next) => {
                        writeSelection(
                          providerId,
                          arrangement,
                          togglePick(
                            selection,
                            windows.map((entry) => entry.windowKey),
                            window.windowKey,
                            next === true,
                          ),
                        );
                      }}
                    />
                    {window.label}
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * Why a provider's limits do nothing right now, naming the Layout switch that
 * decides it and landing on it: the usage readings' Show switch, then this
 * provider's own row in their Profiles list.
 */
function providerLimitsAvailability(
  providerId: RateLimitProviderId,
  usageShown: boolean,
  providerHidden: boolean,
): ShownRowAvailability {
  const jump = (row: string | null): RowJump => ({
    kind: "layout-region",
    regionId: "usageLimits",
    row,
    label: "Open Layout",
  });
  if (!usageShown) {
    return disabledBy("Usage limits are hidden in Layout.", jump(null));
  }
  if (providerHidden) {
    return disabledBy(
      "Hidden in Layout > Usage limits > Profiles.",
      jump(providerId),
    );
  }
  return LIVE;
}

/**
 * What `Choose...` starts from: whatever the strip is drawing for this
 * provider right now, so taking control of the pick does not change the
 * picture in the same gesture. A provider with a reading but no resolved
 * window falls back to its first, because the mode IS the pick list being
 * non-empty and an empty one would bounce straight back to `Automatic`.
 */
function chosenSelection(
  drawnKeys: ReadonlyArray<string>,
  windows: ReadonlyArray<StatusBarRateLimitWindow>,
): StatusBarProviderLimitSelection {
  const seed =
    drawnKeys.length > 0
      ? drawnKeys
      : windows.slice(0, 1).map((window) => window.windowKey);
  return { limitKeys: seed };
}

/**
 * One box ticked or cleared, kept in the catalog's own order.
 *
 * A pick the host no longer reports is KEPT, appended after the live ones: the
 * comment above says a stale pick survives because demoting it would throw the
 * pick away on a reading the user never saw, and filtering the whole list
 * through the live keys made the next tick do exactly that (R1-16). The live
 * ones lead so the stored order still reads as the catalog's.
 */
function togglePick(
  selection: StatusBarProviderLimitSelection,
  order: ReadonlyArray<string>,
  windowKey: string,
  checked: boolean,
): StatusBarProviderLimitSelection {
  const next = new Set(selection.limitKeys);
  if (checked) next.add(windowKey);
  else next.delete(windowKey);
  if (next.size === 0) return selection;
  const live = order.filter((key) => next.has(key));
  const stale = selection.limitKeys.filter(
    (key) => next.has(key) && !order.includes(key),
  );
  return { limitKeys: [...live, ...stale] };
}

/**
 * One provider's whole selection, written through the existing
 * `providerLimits` arrangement seam as ONE recorded gesture - so a tick, a
 * clear and a mode switch are each one press of undo.
 *
 * Automatic is written by DELETING the key, exactly as reverting the change
 * puts a provider back: the entry and its absence mean the same thing to every reader
 * (`statusBarProviderLimitSelection`), so storing one was a mark on the
 * arrangement with nothing behind it (R1-03).
 */
function writeSelection(
  providerId: RateLimitProviderId,
  arrangement: LayoutArrangement,
  selection: StatusBarProviderLimitSelection,
): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    const providerLimits = { ...arrangement.providerLimits };
    if (isAutomaticLimitSelection(selection)) delete providerLimits[providerId];
    else providerLimits[providerId] = selection;
    useLayoutStore
      .getState()
      .setArrangement({ ...arrangement, providerLimits });
  });
}
