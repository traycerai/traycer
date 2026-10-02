import {
  useId,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { Eye, EyeOff, Layers, PanelTop } from "lucide-react";
import { toast } from "sonner";
import { CustomizeLayoutMenuItem } from "@/components/layout-editor/customize-layout-menu-item";
import { regionShownOnValue } from "@/components/layout-editor/layout-gestures";
import {
  readControlValue,
  writeControlValue,
  type RegionControlValue,
} from "@/components/layout-editor/inspector/region-control-io";
import {
  offeredQuickVerbs,
  quickVerbLabel,
  quickVerbToast,
} from "@/components/layout-editor/regions/quick-verbs";
import {
  LAYOUT_REGION_IDS,
  regionFacts,
} from "@/components/layout-editor/regions/region-facts";
import type {
  LayoutRegionIcon,
  QuickVerbId,
} from "@/components/layout-editor/regions/region-grammar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useRegionValues } from "@/lib/layout-overrides";
import { openLayoutEditor } from "@/lib/layout/editor-session";
import { activateTabIntent } from "@/lib/tab-navigation";
import { opensNestedContextMenu } from "@/lib/dom/nested-context-menu";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import {
  regionValuesHidden,
  type LayoutValues,
  type RegionValueKey,
} from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * Right-click on a piece of the app's own chrome (L-19).
 *
 * Three things live here because they are the same offer made in three
 * places: chrome that has no menu of its own gets
 * {@link LayoutRegionContextMenu}, a CONTAINER of such chrome gets
 * {@link LayoutClusterContextMenu}, and chrome that already has a menu renders
 * {@link LayoutRegionMenuItems} inside it. The choice is the call site's
 * because only it knows which of the three it is; what it must not do is give
 * a piece of chrome TWO offers for the same press, which is a menu that names
 * the region and a menu that names the row underneath it, whichever of the two
 * happens to win.
 *
 * A quick verb does NOT enter the editor: it writes the same value the
 * inspector's own switch writes, through the same `region-control-io` seam, and
 * the toast is what reverses it. "Customize layout..." is the way in, and it
 * always opens on the region that was right-clicked.
 */

/**
 * One toast id for every quick verb, so a second verb REPLACES the first's
 * toast rather than stacking beside it.
 *
 * That is what makes Undo exact with no history to consult: the only Undo on
 * screen is the one belonging to the last verb, and it carries that verb's own
 * previous value rather than a snapshot of the whole layout - so it cannot
 * take back a change made between the verb and the press, from this menu or
 * from anywhere else.
 */
const QUICK_VERB_TOAST_ID = "layout-quick-verb";

/** The plan's frozen dismiss for this toast. */
const QUICK_VERB_TOAST_DURATION_MS = 5000;

/**
 * The verb whose toast is still on screen and unresolved, so `layout_quick_verb`
 * can be sent once the toast resolves rather than once per keystroke (L-19,
 * L-46). One slot, because one toast is ever up (`QUICK_VERB_TOAST_ID`): a
 * second verb replaces the first's toast before it resolves either way, which
 * is exactly the case {@link resolvePendingQuickVerb} at the top of
 * {@link run} covers - the superseded verb stood, so it is reported
 * `undone: false` right there rather than lost.
 */
let pendingQuickVerb: {
  readonly regionId: RegionId;
  readonly verb: QuickVerbId;
} | null = null;

function resolvePendingQuickVerb(undone: boolean): void {
  const verb = pendingQuickVerb;
  if (verb === null) return;
  pendingQuickVerb = null;
  Analytics.getInstance().track(AnalyticsEvent.LayoutQuickVerb, {
    region: verb.regionId,
    verb: verb.verb,
    undone,
  });
}

const QUICK_VERB_ICON: Readonly<Record<QuickVerbId, LayoutRegionIcon>> = {
  hide: EyeOff,
  show: Eye,
  chip: Layers,
  full: PanelTop,
};

/**
 * The whole gesture behind a menu item's press, up to and including the
 * pending-verb bookkeeping above (`react-hooks/globals` bans mutating
 * module-scope state from inside a component or hook body, so this - the
 * only piece of {@link LayoutRegionMenuItems} that does - lives outside it
 * instead, called with everything it needs rather than closing over render
 * state).
 */
function runQuickVerb(input: {
  readonly regionId: RegionId;
  readonly verb: QuickVerbId;
  readonly regionName: string;
  readonly values: LayoutValues[RegionId];
  readonly navigate: UseNavigateResult<string>;
}): void {
  const { regionId, verb, regionName, values, navigate } = input;
  // A verb still pending when a new one lands never gets its own
  // dismiss/expire callback - its toast is replaced, not closed - so it is
  // resolved right here as "stood" before the new one's toast opens.
  resolvePendingQuickVerb(false);
  const key = quickVerbKey(verb);
  const previous = readControlValue(values, key);
  writeControlValue(regionId, key, quickVerbValue(verb, regionId));
  pendingQuickVerb = { regionId, verb };
  toast(quickVerbToast(verb, regionId, regionName), {
    id: QUICK_VERB_TOAST_ID,
    duration: QUICK_VERB_TOAST_DURATION_MS,
    // Neither fires for an action/cancel click (sonner calls only that
    // button's own `onClick`), only for an auto-expire or an explicit
    // dismiss - which is exactly the "stood" half of `undone`.
    onAutoClose: () => {
      resolvePendingQuickVerb(false);
    },
    onDismiss: () => {
      resolvePendingQuickVerb(false);
    },
    // Undo is the emphasised button and "Customize layout..." the quiet one,
    // which is the reverse of sonner's own order: leaving the app for the
    // editor is the larger of the two moves, and it must not be the one a
    // reflex press lands on.
    action: {
      label: "Undo",
      onClick: () => {
        writeControlValue(regionId, key, previous);
        resolvePendingQuickVerb(true);
      },
    },
    cancel: {
      label: "Customize layout...",
      onClick: () => {
        resolvePendingQuickVerb(false);
        openLayoutEditor({
          source: "direct_ui",
          entry: "pointer",
          target: regionId,
          origin: { kind: "tab" },
          navigateToTabIntent: (intent) =>
            activateTabIntent(navigate, intent, undefined),
        });
      },
    },
  });
}

/**
 * The region's own verbs, then the way into the editor on that region.
 *
 * The two halves are separate components because a menu over a CONTAINER of
 * regions offers one set of verbs per region it holds and exactly one way in
 * (the strip's, L-159): "Customize layout..." names a screen, and a menu that
 * listed it twice would be offering the same door under two labels.
 */
export function LayoutRegionMenuItems(props: {
  readonly regionId: RegionId;
  /** Items of the chrome's own, before the way in; they draw their own rule. */
  readonly extraItems: ReactNode | null;
}): ReactNode {
  return (
    <>
      <LayoutRegionVerbItems regionId={props.regionId} separator />
      {props.extraItems}
      <CustomizeLayoutMenuItem target={props.regionId} />
    </>
  );
}

/**
 * One region's verbs, with no door of its own (L-159).
 *
 * `separator` is the rule between the verbs and whatever the caller puts
 * after them, and it is the CALLER's because a container drawing several of
 * these wants one rule at the end rather than one per region.
 */
export function LayoutRegionVerbItems(props: {
  readonly regionId: RegionId;
  readonly separator: boolean;
}): ReactNode {
  const { regionId } = props;
  const facts = regionFacts(regionId);
  const values = useRegionValues(regionId);
  const navigate = useNavigate();

  const hidden = regionValuesHidden(values);
  // Asked only of a region whose registry entry says it has a size; a region
  // without one has no `size` leaf to read.
  const sizeable = facts.quickVerbs.includes("chip");
  const chip = sizeable && readControlValue(values, "size") === "chip";
  const verbs = offeredQuickVerbs(facts.quickVerbs, { hidden, chip });

  const separated = props.separator && verbs.length > 0;

  const run = (verb: QuickVerbId): void => {
    runQuickVerb({
      regionId,
      verb,
      regionName: facts.name,
      values,
      navigate,
    });
  };

  return (
    <>
      {verbs.map((verb) => {
        const Icon = QUICK_VERB_ICON[verb];
        return (
          <ContextMenuItem
            key={verb}
            data-testid={`layout-quick-verb-${regionId}-${verb}`}
            onSelect={() => {
              run(verb);
            }}
          >
            <Icon aria-hidden />
            {quickVerbLabel(verb, regionId, facts.name)}
          </ContextMenuItem>
        );
      })}
      {separated ? <ContextMenuSeparator /> : null}
    </>
  );
}

/** A region's menu, for chrome that has none of its own. */
export function LayoutRegionContextMenu(props: {
  readonly regionId: RegionId;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <LayoutRegionContextMenuWithItems
      regionId={props.regionId}
      extraItems={null}
    >
      {props.children}
    </LayoutRegionContextMenuWithItems>
  );
}

/**
 * A region's menu with items of the chrome's own between the region's verbs
 * and the way into the editor - Home's "Tabs" placement group. `extraItems`
 * draws its own trailing separator; the verbs already draw theirs.
 *
 * The same root and the same stand-down trigger as every other region menu,
 * so the operating system keeps its own menu over a selection, a link or an
 * editable field here too.
 */
export function LayoutRegionContextMenuWithItems(props: {
  readonly regionId: RegionId;
  readonly extraItems: ReactNode | null;
  readonly children: ReactNode;
}): ReactNode {
  // The menu can open over a title-bar drag region (the vertical strip's top
  // block and spacer, the header row); the drag regions stand down while it
  // is open so its items and an outside click land in the renderer.
  const [open, setOpen] = useState(false);
  useTitleBarDragSuppression(`region-menu:${useId()}`, open);
  return (
    <ContextMenu onOpenChange={setOpen}>
      {/* `display: contents` generates no box, so the chrome this wraps keeps
          its own place in its parent's flex or grid row; the span is only
          somewhere for Radix to hang the trigger's handlers, which the real
          control's own contextmenu event bubbles up to. Wrapping here rather
          than at each call site means a site can hand this a COMPONENT - the
          Home item, a toolbar picker - without that component having to
          forward the trigger's props to a DOM node. */}
      <ContextMenuTrigger asChild ref={REGION_TRIGGER_REF}>
        <span className="contents">{props.children}</span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <LayoutRegionMenuItems
          regionId={props.regionId}
          extraItems={props.extraItems}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One menu for a whole strip of regions, naming whichever one the pointer was
 * over (G3-10).
 *
 * A root per ITEM is what this replaces: the composer's two clusters draw
 * seven controls between them and every open chat tile draws both, so a
 * four-tile canvas was carrying twenty-eight Radix roots and twenty-eight
 * trigger spans for a gesture used a handful of times a session. The region is
 * resolved from the event the same way the canvas resolves a hover, so the
 * verbs are still per item.
 *
 * The child is the cluster's own box, taken `asChild`, so this adds no element
 * of its own.
 *
 * It is the right shape for any container of regions, not only a strip of
 * small controls: the dock's pill row and the joined frame of full rows each
 * take one (L-144), which is what gives every dock member its verbs for two
 * roots per tile rather than one per member.
 *
 * What a container must NOT do is answer a press that belongs to something
 * else, and the dock is mounted in the real chat for every user at rest, so
 * "something else" is mostly the operating system: a selected file path, a
 * link in a Background item, a text field. {@link osOwnsContextMenu} names
 * those and {@link CLUSTER_TRIGGER_REF} stands down on them, along with a
 * press that resolves to no region at all - the frame's own padding, which
 * used to be a dead gesture that opened nothing and suppressed the app's menu
 * as well.
 *
 * A container MAY also hold a control with a menu of its own, and the
 * innermost one wins with nothing written here: Radix's trigger composes the
 * caller's handler ahead of its own opener and SKIPS that opener once the
 * event is default-prevented, which the inner trigger has already done by the
 * time the event reaches this one. The transcript's web links nest one; they
 * carry `NESTED_CONTEXT_MENU_PROPS` so the stand-down above lets their
 * press through instead of handing it to the OS. `region-quick-verbs.test.tsx`
 * measures the default-prevented half so it cannot quietly stop being true.
 */
export function LayoutClusterContextMenu(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [regionId, setRegionId] = useState<RegionId | null>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        ref={CLUSTER_TRIGGER_REF}
        onContextMenu={(event: MouseEvent<HTMLElement>) => {
          // Only ever reached with a region under the pointer: the refusal
          // above has already taken the event out of React's reach otherwise.
          setRegionId(regionUnder(event.target));
        }}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          // A touch or pen press arms Radix's long-press timer on every
          // trigger it bubbles through, and the inner menu's contextmenu
          // default-prevent never reaches this one's timer. Default-preventing
          // here makes Radix skip arming it, so a nested menu's long-press
          // opens that menu alone.
          if (
            event.pointerType !== "mouse" &&
            opensNestedContextMenu(event.target)
          ) {
            event.preventDefault();
          }
        }}
      >
        {props.children}
      </ContextMenuTrigger>
      {regionId === null ? null : (
        <ContextMenuContent>
          <LayoutRegionMenuItems regionId={regionId} extraItems={null} />
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

function regionUnder(target: EventTarget | null): RegionId | null {
  if (!(target instanceof Element)) return null;
  const value = target
    .closest("[data-layout-region]")
    ?.getAttribute("data-layout-region");
  return LAYOUT_REGION_IDS.find((id) => id === value) ?? null;
}

/**
 * What the operating system's own menu is for: a link, an editable field, or
 * text the user has selected.
 *
 * Electron answers those with Copy, Copy Link and the spell-check suggestions
 * (`clients/desktop/src/electron-main/app/spell-check.ts`), and it only ever
 * hears about the press because Chromium sent `ShowContextMenu`, which it does
 * not do for an event something called `preventDefault` on.
 *
 * The selection test asks whether the selection is UNDER the pointer, not
 * whether one exists: a selection left behind in the transcript is not what a
 * right-click on a dock row is about.
 */
function osOwnsContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(OS_MENU_CONTENT_SELECTOR) !== null) return true;
  const selection = target.ownerDocument.defaultView?.getSelection() ?? null;
  if (selection === null || selection.isCollapsed) return false;
  return Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  ).some((range) => range.intersectsNode(target));
}

const OS_MENU_CONTENT_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], a[href]';

/**
 * A press this menu stands down from, refused AT the trigger before Radix can
 * take it.
 *
 * There is no way to stand down from inside a handler passed to the trigger.
 * Radix composes the caller's `onContextMenu` ahead of its own opener and
 * skips that opener only when the event is already default-prevented - and
 * default-prevented is exactly the state that removes the native menu. So the
 * refusal has to stop the event from reaching React's dispatch at all, which
 * leaves `defaultPrevented` false for Chromium to act on.
 *
 * A native capture listener rather than `onContextMenuCapture`, and the
 * ordering is the whole reason: React dispatches its capture phase from the
 * ROOT container, which is above the editor's app column, so a React capture
 * handler would run BEFORE `canvas/edit-firewall.ts`'s own capture listener
 * and take decisions that belong to the firewall - a press on the sample
 * scene's padding during a session, say, which the firewall swallows and this
 * hands to the OS. Bound on the trigger, this runs after the firewall and only
 * on presses the firewall let by.
 */
function standDownRef(
  standsDown: (target: EventTarget | null) => boolean,
): (node: HTMLElement | null) => (() => void) | undefined {
  const refuse = (event: Event): void => {
    // An inner app menu (a markdown web link's) must still receive its press.
    // It default-prevents the event, which already keeps this trigger's own
    // opener shut, so there is nothing to refuse.
    if (opensNestedContextMenu(event.target)) return;
    if (standsDown(event.target)) event.stopPropagation();
  };
  return (node) => {
    if (node === null) return undefined;
    node.addEventListener("contextmenu", refuse, true);
    return () => {
      node.removeEventListener("contextmenu", refuse, true);
    };
  };
}

/** A region's own menu stands down only for the OS: it names one region. */
const REGION_TRIGGER_REF = standDownRef(osOwnsContextMenu);

/** A cluster's also stands down where the press names no region at all. */
const CLUSTER_TRIGGER_REF = standDownRef(
  (target) => osOwnsContextMenu(target) || regionUnder(target) === null,
);

/** Which leaf a verb writes. */
function quickVerbKey(verb: QuickVerbId): RegionValueKey {
  return verb === "chip" || verb === "full" ? "size" : "shown";
}

/** What it writes there - `show` through the one tri-state rule (L-47). */
function quickVerbValue(
  verb: QuickVerbId,
  regionId: RegionId,
): RegionControlValue {
  switch (verb) {
    case "hide":
      return "hidden";
    case "show":
      return regionShownOnValue(regionId);
    case "chip":
      return "chip";
    case "full":
      return "full";
  }
}
