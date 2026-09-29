// T06 production lifecycle gate — promotes T02's positive Dialog/Popover
// Activity-concealment cases (base-ui-proofs.tsx's LifecycleProof /
// LifecycleHostBoundary) onto the REAL production stack: the actual
// PortalConcealmentBoundary (portal-concealment-context.tsx), the actual
// SurfacePresentationBoundary (layout/surface-presentation-boundary.tsx) for
// pane focus/visibility, the actual Dialog/Popover wrappers with their native
// onOpenChange/onOpenChangeComplete/initialFocus/finalFocus callbacks, and
// the actual useOverlayFrame for the nested case. T02's own fixture stays
// untouched; this is a separate module, driven by
// scripts/portal-lifecycle-gate.mjs over CDP.
import {
  useState,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import {
  paneActivationDeferProps,
  usePaneActivationOwnership,
} from "@/components/epic-canvas/pane-activation";
import "@/index.css";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Popover as NativePopover } from "@base-ui/react/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Menu as NativeMenu } from "@base-ui/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Select as NativeSelect } from "@base-ui/react/select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ContextMenu as NativeContextMenu } from "@base-ui/react/context-menu";
import { Button } from "@/components/ui/button";
import { PortalConcealmentBoundary } from "@/components/ui/portal-concealment-context";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import {
  OverlayFrameContext,
  useOverlayFrame,
} from "@/components/ui/overlay-frame-context";

const params = new URLSearchParams(location.search);
const familyParam = params.get("family");
const family =
  familyParam === "popover" ||
  familyParam === "menu" ||
  familyParam === "select" ||
  familyParam === "context"
    ? familyParam
    : "dialog";
const controlled = params.get("controlled") !== "false";
const nested = params.get("nested") === "true";
// R2: an owner that closes by removing its `open`-literal Root entirely
// (ThemeManager's actual pattern - `open` never flips to `false`) instead of
// toggling `open`/`onOpenChange` on a Root that stays mounted.
const conditionalRoot = params.get("conditionalRoot") === "true";
// Menu/Select's conditionalRoot flavor keeps a real Trigger inside the Root
// (see `Owner`'s own comment on this), so it needs to be told apart from the
// popover|dialog flavor in two separate places - hoisted here once so both
// reads are the same derived fact, not two copies of the same condition.
const conditionalRootTriggerFamily =
  conditionalRoot && (family === "menu" || family === "select");
// R5: a child that focuses itself in a mount effect, before Base ever
// invokes the wrapper's deferred `initialFocus` resolver - the real
// `GitDiffRepoSwitcherDropdown` / `WorktreeFolderList` pattern.
const autofocus = params.get("autofocus") === "true";
// Coordinator parity case: unwrapped Base 1.8 Popover, no wrapper focus
// core - the measured baseline the wrapper's outside-press behavior must
// match, not an assumed one.
const native = params.get("native") === "true";
// Menu/Select Root default to `modal: true` (a backdrop disables outside
// pointer interaction) - the same default on both the wrapper and the
// native parity side, so an "outside press" case can choose to measure
// either the genuinely nonmodal policy or the real default-modal backdrop
// intercept, deliberately rather than by accident.
const modal = params.get("modal") !== "false";
// Context family: `primitive-gate.tsx`'s own ContextMenu case wraps a real
// focusable `<Button>` inside the trigger span, not plain text - a real
// right-click CAN land focus on that child button, unlike the plain-text
// span shape, so the two need to be measured as distinct variants.
const contextButton = params.get("contextButton") === "true";
// Select's Activity-reopen matrix needs both an already-committed value and
// an unset one - a reopen's restored highlight has a different source item
// in each case (the committed value vs the last-navigated-to option).
const selectHasValue = params.get("value") !== "none";
// Wires the real usePaneActivationOwnership hook so a click on a cold
// trigger activates the pane through production's real commit ordering.
const coldActivation = params.get("coldActivation") === "true";
// Portals this Root's own Trigger DOM into a second pane while Root/Content
// stay under pane A - exercises isOwnPaneTriggerEvent's pane-adjacency check.
const foreignPaneTrigger = params.get("foreignPaneTrigger") === "true";
// Matches base-ui-proofs.tsx's ContextMenu.Item closeOnClick={false}: Enter
// on an item must not close the popup, so a conceal-while-open cycle is real.
const keepOpen = params.get("keepOpen") === "true";
// R1/R2 parity: Owner's own onOpenChangeComplete-driven `completes` counter
// forces an extra post-close rerender once aria-controls has already
// disappeared, which re-derives the wrapper's resolved focus target and can
// mask a stale-value bug that a plainer consumer (no completion callback)
// would still show. Skips only the state update, not the event record.
const quietComplete = params.get("quietComplete") === "true";

interface Frame {
  readonly registry: Set<object>;
}

declare global {
  interface Window {
    gate: {
      conceal: (next: boolean) => void;
      rapidConcealReveal: () => void;
      focusPane: (next: boolean) => void;
      visiblePane: (next: boolean) => void;
      openOuter: () => void;
      closeOwner: () => void;
      rapidOpenClose: () => void;
      openNested: () => void;
      events: string[];
      focusEvents: string[];
      blurEvents: string[];
    };
  }
}
window.gate = {
  conceal: () => undefined,
  rapidConcealReveal: () => undefined,
  focusPane: () => undefined,
  visiblePane: () => undefined,
  openOuter: () => undefined,
  closeOwner: () => undefined,
  rapidOpenClose: () => undefined,
  openNested: () => undefined,
  events: [],
  focusEvents: [],
  blurEvents: [],
};

/**
 * Registered under the outer overlay's `OverlayFrameContext` via the real
 * `useOverlayFrame()` - `useOverlayFrameRegistration` inside the app's own
 * Dialog/Popover wrapper picks this up automatically while open. Proves a
 * nested overlay's own logical state and content survive the SAME
 * concealment/return cycle as its owner, independently.
 */
function NestedOverlay(): ReactNode {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("nested staged");
  useLayoutEffect(() => {
    window.gate.openNested = () => flushSync(() => setOpen(true));
  }, []);
  const body = (
    <label>
      Nested draft
      <input
        aria-label="Nested draft"
        data-gate-nested-draft
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  );
  return family === "popover" ? (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger data-gate-nested-trigger>Nested</PopoverTrigger>
      <PopoverContent data-gate-subpopup aria-label="Nested popover">
        {body}
      </PopoverContent>
    </Popover>
  ) : (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger data-gate-nested-trigger>Nested</DialogTrigger>
      <DialogContent data-gate-subpopup aria-describedby={undefined}>
        <DialogTitle>Nested</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function Content({ frame }: { readonly frame: Frame | null }): ReactNode {
  const [draft, setDraft] = useState("staged");
  const draftRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    window.gate.events.push("content:connect");
    // Focus this child in a mount effect, same as it does in real callers -
    // before Base ever invokes the wrapper's deferred `initialFocus`
    // resolver, so `active` is already inside the popup by the time that
    // resolver runs.
    if (autofocus) draftRef.current?.focus();
    return () => {
      window.gate.events.push("content:disconnect");
    };
  }, []);
  return (
    <div data-gate-content>
      <label>
        Draft
        <input
          ref={draftRef}
          aria-label="Draft"
          data-gate-draft
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button type="button" data-gate-close>
        Close
      </button>
      {frame ? (
        <OverlayFrameContext.Provider value={frame.registry}>
          <NestedOverlay />
        </OverlayFrameContext.Provider>
      ) : null}
    </div>
  );
}

/**
 * Menu/Select are roving-focus composite widgets, not a draft-input form
 * like `Content` - the item-click and hover-submenu-close scenarios need
 * real items/a real submenu, not a generic input. `data-gate-item` is the
 * item-click scenario's target; the submenu is menu-only (Select has none).
 */
function MenuItems(): ReactNode {
  const firstRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    window.gate.events.push("content:connect");
    // Same R5 shape as `Content`: focus this item in a mount effect, before
    // Base's own roving-focus setup runs.
    if (autofocus) firstRef.current?.focus();
    return () => {
      window.gate.events.push("content:disconnect");
    };
  }, []);
  return (
    <>
      <DropdownMenuItem
        ref={firstRef}
        data-gate-item
        onClick={() => window.gate.events.push("item:click")}
      >
        Item A
      </DropdownMenuItem>
      <DropdownMenuItem>Item B</DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-gate-subtrigger>
          More
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent data-gate-subpopup>
          <DropdownMenuItem data-gate-subitem>Sub Item</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

const SELECT_ITEMS = { a: "Option A", b: "Option B" };

function SelectItems(): ReactNode {
  const firstRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    window.gate.events.push("content:connect");
    if (autofocus) firstRef.current?.focus();
    return () => {
      window.gate.events.push("content:disconnect");
    };
  }, []);
  return (
    <>
      <SelectItem
        ref={firstRef}
        value="a"
        data-gate-item
        onClick={() => window.gate.events.push("item:click")}
      >
        Option A
      </SelectItem>
      <SelectItem value="b">Option B</SelectItem>
    </>
  );
}

/**
 * Minimal ContextMenu content - the item-click tracking mirrors
 * `MenuItems`/`SelectItems` (same `item:click` event), needed by the
 * Activity-reopen matrix to prove a reopened menu's Enter-key activation
 * still fires; no submenu coverage here (unlike `MenuItems`).
 */
function ContextItems(): ReactNode {
  useLayoutEffect(() => {
    window.gate.events.push("content:connect");
    return () => {
      window.gate.events.push("content:disconnect");
    };
  }, []);
  return (
    <>
      <ContextMenuItem
        data-gate-item
        closeOnClick={!keepOpen}
        onClick={() => window.gate.events.push("item:click")}
      >
        Item A
      </ContextMenuItem>
      <ContextMenuItem closeOnClick={!keepOpen}>Item B</ContextMenuItem>
    </>
  );
}

/**
 * The `conditionalRoot && (menu|select)` case: a real Trigger inside the
 * Root (open normally, through the widget's own interaction), plus a
 * persistent external button OUTSIDE the Root that never unmounts.
 * `finalFocus` points at that external button - not the trigger that is
 * about to disappear - so `closeOwner()` unmounting the WHOLE subtree
 * (Trigger included) still has a real destination to restore to. This is
 * the supported way to exercise "root unmount while open" for these two
 * families, since neither wrapper's Positioner exposes an `anchor` prop the
 * way Popover's does.
 */
function ConditionalRootTriggerOwner({
  family,
  internalOpen,
  onOpenChange,
  onOpenChangeComplete,
  conditionalTriggerRef,
  output,
}: {
  readonly family: "menu" | "select";
  readonly internalOpen: boolean;
  readonly onOpenChange: (next: boolean, details: { reason: string }) => void;
  readonly onOpenChangeComplete: (next: boolean) => void;
  readonly conditionalTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly output: ReactNode;
}): ReactNode {
  const root =
    family === "select" ? (
      <Select
        items={SELECT_ITEMS}
        defaultValue="a"
        onOpenChange={onOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <SelectTrigger data-gate-trigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-gate-popup finalFocus={conditionalTriggerRef}>
          <SelectItems />
        </SelectContent>
      </Select>
    ) : (
      <DropdownMenu
        onOpenChange={onOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <DropdownMenuTrigger data-gate-trigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent data-gate-popup finalFocus={conditionalTriggerRef}>
          <MenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <>
      {output}
      <button ref={conditionalTriggerRef} type="button" data-gate-return>
        Return
      </button>
      {internalOpen ? root : null}
    </>
  );
}

/**
 * The `conditionalRoot` (popover|dialog) case: `open` stays a literal `true`
 * for the Root's whole mounted lifetime - closing is the PARENT removing the
 * Root from the tree, never an onOpenChange round trip, so `cycle.open` is
 * never committed `false`.
 */
function ConditionalRootOuterOwner({
  family,
  internalOpen,
  conditionalTriggerRef,
  initialFocus,
  finalFocus,
  frame,
  output,
}: {
  readonly family: "popover" | "dialog";
  readonly internalOpen: boolean;
  readonly conditionalTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly initialFocus: () => boolean;
  readonly finalFocus: () => boolean;
  readonly frame: Frame | null;
  readonly output: ReactNode;
}): ReactNode {
  const root =
    family === "popover" ? (
      <Popover open>
        <PopoverContent
          data-gate-popup
          aria-label="Lifecycle popover"
          anchor={conditionalTriggerRef}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <Content frame={frame} />
        </PopoverContent>
      </Popover>
    ) : (
      <Dialog open>
        <DialogContent
          data-gate-popup
          aria-describedby={undefined}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <DialogTitle>Lifecycle dialog</DialogTitle>
          <Content frame={frame} />
        </DialogContent>
      </Dialog>
    );
  return (
    <>
      {output}
      <button
        ref={conditionalTriggerRef}
        type="button"
        data-gate-trigger
        onClick={() => window.gate.openOuter()}
      >
        Open
      </button>
      {internalOpen ? root : null}
    </>
  );
}

type LifecycleRootProps =
  | {
      readonly open: boolean;
      readonly onOpenChange: (
        next: boolean,
        details: { reason: string },
      ) => void;
      readonly onOpenChangeComplete: (next: boolean) => void;
    }
  | {
      readonly defaultOpen: false;
      readonly onOpenChange: (
        next: boolean,
        details: { reason: string },
      ) => void;
      readonly onOpenChangeComplete: (next: boolean) => void;
    };
// Pulled out of `Owner` purely to keep its own complexity in check - same
// trigger/cold-activation/foreign-portal wiring, no behavior change.
function PopoverOwner({
  rootProps,
  foreignTriggerPortalTarget,
  initialFocus,
  finalFocus,
  frame,
  output,
}: {
  readonly rootProps: LifecycleRootProps;
  readonly foreignTriggerPortalTarget: HTMLElement | null;
  readonly initialFocus: () => boolean;
  readonly finalFocus: () => boolean;
  readonly frame: Frame | null;
  readonly output: ReactNode;
}): ReactNode {
  const trigger = (
    <PopoverTrigger
      data-gate-trigger
      {...(coldActivation ? paneActivationDeferProps : {})}
    >
      Open
    </PopoverTrigger>
  );
  return (
    <>
      {output}
      <Popover {...rootProps}>
        {foreignTriggerPortalTarget
          ? createPortal(trigger, foreignTriggerPortalTarget)
          : trigger}
        <PopoverContent
          data-gate-popup
          aria-label="Lifecycle popover"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <Content frame={frame} />
        </PopoverContent>
      </Popover>
    </>
  );
}
// Pulled out of `Owner` for the same reason as `PopoverOwner` - same
// trigger/cold-activation/foreign-portal wiring, no behavior change.
function MenuOwner({
  rootProps,
  foreignTriggerPortalTarget,
  output,
}: {
  readonly rootProps: LifecycleRootProps;
  readonly foreignTriggerPortalTarget: HTMLElement | null;
  readonly output: ReactNode;
}): ReactNode {
  const trigger = (
    <DropdownMenuTrigger
      data-gate-trigger
      {...(coldActivation ? paneActivationDeferProps : {})}
    >
      Open
    </DropdownMenuTrigger>
  );
  return (
    <>
      {output}
      <DropdownMenu modal={modal} {...rootProps}>
        {foreignTriggerPortalTarget
          ? createPortal(trigger, foreignTriggerPortalTarget)
          : trigger}
        <DropdownMenuContent data-gate-popup>
          <MenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function Owner({
  foreignTriggerPortalTarget,
}: {
  readonly foreignTriggerPortalTarget: HTMLElement | null;
}): ReactNode {
  // Menu/Select's conditionalRoot flavor keeps a real Trigger inside the
  // Root (neither wrapper exposes a Positioner `anchor` prop the way
  // Popover does), so the Root+Trigger must already be mounted for `load()`
  // to find `[data-gate-trigger]` at all - unlike Dialog/Popover's
  // conditionalRoot, which starts unmounted behind an external opener.
  const [internalOpen, setInternalOpen] = useState(
    () => conditionalRootTriggerFamily,
  );
  const [changes, setChanges] = useState(0);
  const [completes, setCompletes] = useState(0);
  const [finals, setFinals] = useState(0);
  const [initials, setInitials] = useState(0);
  const frameHook = useOverlayFrame();
  const frame: Frame | null = nested ? frameHook : null;
  // Popover's conditionalRoot: no `PopoverTrigger` inside the Root (the Root
  // itself is what unmounts), so the Positioner needs an explicit anchor.
  // Menu/Select's conditionalRoot reuses this same ref as the `finalFocus`
  // destination instead - a persistent button OUTSIDE the Root, which is
  // what proves the root-unmount adapter path without needing a Positioner
  // anchor prop that neither wrapper exposes.
  const conditionalTriggerRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    window.gate.openOuter = () => flushSync(() => setInternalOpen(true));
    window.gate.closeOwner = () => flushSync(() => setInternalOpen(false));
    // Mirrors rapidConcealReveal(): the first flip commits (flushSync, its
    // effects run), the second is issued right after in the same turn with
    // no flushSync of its own - the fastest reachable-from-outside interrupt
    // of the OPEN transition itself, before it can ever settle.
    window.gate.rapidOpenClose = () => {
      flushSync(() => setInternalOpen(true));
      setInternalOpen(false);
    };
  }, []);
  const onOpenChange = (next: boolean, details: { reason: string }): void => {
    window.gate.events.push(`change:${next}:${details.reason}`);
    setChanges((count) => count + 1);
    setInternalOpen(next);
  };
  const onOpenChangeComplete = (next: boolean): void => {
    window.gate.events.push(`complete:${next}`);
    if (!quietComplete) setCompletes((count) => count + 1);
  };
  const initialFocus = (): boolean => {
    setInitials((count) => count + 1);
    return true;
  };
  const finalFocus = (): boolean => {
    setFinals((count) => count + 1);
    return true;
  };
  const rootProps: LifecycleRootProps = controlled
    ? { open: internalOpen, onOpenChange, onOpenChangeComplete }
    : { defaultOpen: false, onOpenChange, onOpenChangeComplete };
  const output = (
    <div
      data-gate-state
      data-changes={changes}
      data-completes={completes}
      data-finals={finals}
      data-initials={initials}
    />
  );
  // Re-tested here (not read from the hoisted boolean) so TS narrows
  // `family` to "menu" | "select" for the prop below.
  if (conditionalRoot && (family === "menu" || family === "select"))
    return (
      <ConditionalRootTriggerOwner
        family={family}
        internalOpen={internalOpen}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
        conditionalTriggerRef={conditionalTriggerRef}
        output={output}
      />
    );
  if (conditionalRoot)
    return (
      <ConditionalRootOuterOwner
        family={family === "popover" ? "popover" : "dialog"}
        internalOpen={internalOpen}
        conditionalTriggerRef={conditionalTriggerRef}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        frame={frame}
        output={output}
      />
    );
  if (family === "popover")
    return (
      <PopoverOwner
        rootProps={rootProps}
        foreignTriggerPortalTarget={foreignTriggerPortalTarget}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        frame={frame}
        output={output}
      />
    );
  // Menu/Select: no custom `finalFocus` here - passing any function/ref
  // changes the default outside-focus policy (`usesDefaultTarget` in
  // `useClosingOverlayFocus`), and these are the "default path" cases
  // (Tab-out, outside click, Escape, item click, hover-submenu-close) that
  // must measure the wrapper's UNMODIFIED default behavior against native.
  // Neither Popup supports `initialFocus` at all, so `initials` stays 0.
  if (family === "select")
    return (
      <>
        {output}
        <Select
          items={SELECT_ITEMS}
          defaultValue={selectHasValue ? "a" : undefined}
          modal={modal}
          {...rootProps}
        >
          <SelectTrigger data-gate-trigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-gate-popup>
            <SelectItems />
          </SelectContent>
        </Select>
      </>
    );
  if (family === "menu")
    return (
      <MenuOwner
        rootProps={rootProps}
        foreignTriggerPortalTarget={foreignTriggerPortalTarget}
        output={output}
      />
    );
  if (family === "context")
    return (
      <>
        {output}
        <ContextMenu {...rootProps}>
          <ContextMenuTrigger data-gate-trigger>
            {contextButton ? (
              <Button>Right-click for actions</Button>
            ) : (
              "Right-click for actions"
            )}
          </ContextMenuTrigger>
          <ContextMenuContent data-gate-popup>
            <ContextItems />
          </ContextMenuContent>
        </ContextMenu>
      </>
    );
  return (
    <>
      {output}
      <Dialog {...rootProps}>
        <DialogTrigger data-gate-trigger>Open</DialogTrigger>
        <DialogContent
          data-gate-popup
          aria-describedby={undefined}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <DialogTitle>Lifecycle dialog</DialogTitle>
          <Content frame={frame} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Unwrapped `@base-ui/react/popover` - no `useOverlayFocus`/
 * `useOverlayPresentation`, no `initialFocus`/`finalFocus`. Exists only to
 * MEASURE Base's own default outside-press behavior for the parity case;
 * never asserted against directly by any other case.
 */
function NativePopoverParity(): ReactNode {
  return (
    <NativePopover.Root>
      <NativePopover.Trigger data-gate-trigger>Open</NativePopover.Trigger>
      <NativePopover.Portal>
        <NativePopover.Positioner>
          <NativePopover.Popup
            data-gate-popup
            aria-label="Native parity popover"
          >
            <input aria-label="Draft" data-gate-draft defaultValue="staged" />
          </NativePopover.Popup>
        </NativePopover.Positioner>
      </NativePopover.Portal>
    </NativePopover.Root>
  );
}

/**
 * Unwrapped `@base-ui/react/menu` - no `useClosingOverlay`/
 * `useClosingOverlayFocus`, no `finalFocus`. Same item/submenu shape as
 * `MenuItems` so the native-vs-wrapper cases (Tab-out, outside click,
 * Escape, item click, hover-submenu-close) compare like for like.
 */
// Records the SAME `controlled` configuration (from the URL, same as
// `Owner()`'s own `rootProps`) and change/complete counts as the wrapper -
// without this, a native-vs-production callback-count comparison is
// comparing an always-uncontrolled native fixture against a controlled
// production one, which is not a fair measurement of either side's real
// behavior.
function useNativeRootProps() {
  const [open, setOpen] = useState(false);
  // Mirrors `Owner()`'s own `window.gate.openOuter`/`closeOwner` levers so the
  // driver can exercise native and wrapper sides with identical calls.
  useLayoutEffect(() => {
    if (!controlled) return;
    window.gate.openOuter = () => flushSync(() => setOpen(true));
    window.gate.closeOwner = () => flushSync(() => setOpen(false));
  }, []);
  if (!controlled) return {};
  return {
    open,
    onOpenChange: (next: boolean, details: { reason: string }): void => {
      window.gate.events.push(`native-change:${next}:${details.reason}`);
      setOpen(next);
    },
    onOpenChangeComplete: (next: boolean): void => {
      window.gate.events.push(`native-complete:${next}`);
    },
  };
}

function NativeMenuParity(): ReactNode {
  const rootProps = useNativeRootProps();
  return (
    <NativeMenu.Root modal={modal} {...rootProps}>
      <NativeMenu.Trigger data-gate-trigger>Open</NativeMenu.Trigger>
      <NativeMenu.Portal>
        <NativeMenu.Positioner>
          <NativeMenu.Popup data-gate-popup aria-label="Native parity menu">
            <NativeMenu.Item
              data-gate-item
              onClick={() => window.gate.events.push("item:click")}
            >
              Item A
            </NativeMenu.Item>
            <NativeMenu.Item>Item B</NativeMenu.Item>
            <NativeMenu.SubmenuRoot>
              <NativeMenu.SubmenuTrigger data-gate-subtrigger>
                More
              </NativeMenu.SubmenuTrigger>
              <NativeMenu.Portal>
                <NativeMenu.Positioner>
                  <NativeMenu.Popup
                    data-gate-subpopup
                    aria-label="Native parity submenu"
                  >
                    <NativeMenu.Item data-gate-subitem>
                      Sub Item
                    </NativeMenu.Item>
                  </NativeMenu.Popup>
                </NativeMenu.Positioner>
              </NativeMenu.Portal>
            </NativeMenu.SubmenuRoot>
          </NativeMenu.Popup>
        </NativeMenu.Positioner>
      </NativeMenu.Portal>
    </NativeMenu.Root>
  );
}

/**
 * Unwrapped `@base-ui/react/select` - no `useClosingOverlay`/
 * `useClosingOverlayFocus`, no `finalFocus`. Same item shape as
 * `SelectItems` for the same native-vs-wrapper comparisons.
 */
function NativeSelectParity(): ReactNode {
  const rootProps = useNativeRootProps();
  return (
    <NativeSelect.Root
      items={SELECT_ITEMS}
      defaultValue="a"
      modal={modal}
      {...rootProps}
    >
      <NativeSelect.Trigger data-gate-trigger>
        <NativeSelect.Value />
      </NativeSelect.Trigger>
      <NativeSelect.Portal>
        {/* `alignItemWithTrigger={false}` matches production's own
            SelectContent - the default `true` needs the selected item's
            ItemText geometry to compute its overlap offset, which is a
            positioning concern orthogonal to what these cases measure. */}
        <NativeSelect.Positioner alignItemWithTrigger={false}>
          <NativeSelect.Popup data-gate-popup aria-label="Native parity select">
            <NativeSelect.List>
              <NativeSelect.Item
                value="a"
                data-gate-item
                onClick={() => window.gate.events.push("item:click")}
              >
                <NativeSelect.ItemText>Option A</NativeSelect.ItemText>
              </NativeSelect.Item>
              <NativeSelect.Item value="b">
                <NativeSelect.ItemText>Option B</NativeSelect.ItemText>
              </NativeSelect.Item>
            </NativeSelect.List>
          </NativeSelect.Popup>
        </NativeSelect.Positioner>
      </NativeSelect.Portal>
    </NativeSelect.Root>
  );
}

/**
 * Unwrapped `@base-ui/react/context-menu` - no `useClosingOverlay`/
 * `useClosingOverlayFocus`, no `finalFocus`. Establishes native Base's own
 * Escape-close destination: a real right-click on a non-focusable trigger
 * span does not itself focus anything, so what Escape restores to (the
 * previously-focused element vs the trigger vs body) needs to be measured,
 * not assumed.
 */
function NativeContextParity(): ReactNode {
  return (
    <NativeContextMenu.Root>
      {/* `render={<span/>}` matches production's own ContextMenuTrigger -
          Base's own default is a block `<div>`, and a block vs. inline
          element gives `center()` a different right-click point, which
          would make the two sides' measurements not comparable. */}
      <NativeContextMenu.Trigger data-gate-trigger render={<span />}>
        {contextButton ? (
          <Button>Right-click for actions</Button>
        ) : (
          "Right-click for actions"
        )}
      </NativeContextMenu.Trigger>
      <NativeContextMenu.Portal>
        <NativeContextMenu.Positioner>
          <NativeContextMenu.Popup
            data-gate-popup
            aria-label="Native parity context menu"
          >
            <NativeContextMenu.Item data-gate-item>
              Item A
            </NativeContextMenu.Item>
            <NativeContextMenu.Item>Item B</NativeContextMenu.Item>
          </NativeContextMenu.Popup>
        </NativeContextMenu.Positioner>
      </NativeContextMenu.Portal>
    </NativeContextMenu.Root>
  );
}

function ownerOrNativeParity(
  foreignTriggerPortalTarget: HTMLElement | null,
): ReactNode {
  if (!native)
    return <Owner foreignTriggerPortalTarget={foreignTriggerPortalTarget} />;
  if (family === "menu") return <NativeMenuParity />;
  if (family === "select") return <NativeSelectParity />;
  if (family === "context") return <NativeContextParity />;
  return <NativePopoverParity />;
}

export function Fixture(): ReactNode {
  const [concealed, setConcealed] = useState(false);
  const [focused, setFocused] = useState(true);
  const [visible, setVisible] = useState(true);
  const [paneBContainer, setPaneBContainer] = useState<HTMLDivElement | null>(
    null,
  );
  // Always wired - it is a genuine no-op unless a pointerdown actually lands
  // inside this pane while `focused` is false, which no OTHER case in this
  // file does (they only flip `focused` via `window.gate.focusPane`, never
  // by clicking while cold). Only ATTACHED to the pane wrapper when
  // `coldActivation` is set, so every other case's DOM shape is unchanged.
  const activation = usePaneActivationOwnership({
    active: focused,
    activate: () => setFocused(true),
  });
  useLayoutEffect(() => {
    const focusEvents = window.gate.focusEvents;
    const recordFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Base's FocusGuard sentinels (`utils/FocusGuard.mjs` - an invisible
      // `<span data-base-ui-focus-guard>` at a focus trap's boundary)
      // receive transient focus mid-teardown; they are never a real app
      // destination. Tag them distinctly rather than folding them into "A"
      // silently, so a genuine unexpected refocus (to the trigger, the
      // popup, anywhere else real) stays visible in the raw sequence
      // instead of being hidden behind this exclusion.
      if (target.hasAttribute("data-base-ui-focus-guard")) {
        focusEvents.push("G");
        return;
      }
      focusEvents.push(target.matches("[data-gate-outside]") ? "B" : "A");
    };
    // Companion blur tracker, kept in its own array so it never contaminates
    // the many existing `focusEvents` assertions elsewhere in this file.
    const blurEvents = window.gate.blurEvents;
    const recordBlur = (event: FocusEvent): void => {
      if (event.target instanceof Element) blurEvents.push("blur");
    };
    document.addEventListener("focusin", recordFocus);
    document.addEventListener("focusout", recordBlur);
    // Mirrors primitive-gate.tsx's own pane-switch transaction: one flushed
    // commit, then an explicit move to Pane B's control - never waiting for
    // library cleanup to "repair" focus afterward.
    const transfer = (commit: () => void): void => {
      focusEvents.length = 0;
      flushSync(commit);
      document.querySelector<HTMLElement>("[data-gate-outside]")?.focus();
    };
    window.gate.conceal = (next) => flushSync(() => setConcealed(next));
    window.gate.rapidConcealReveal = () => {
      // The FIRST flip commits and its passive effects are allowed to run
      // (flushSync forces that); the SECOND is issued right after, in the
      // same synchronous turn, WITHOUT its own flushSync, so it can land
      // before React schedules/flushes anything from the first flip that
      // hasn't already run synchronously.
      flushSync(() => setConcealed(true));
      setConcealed(false);
    };
    window.gate.focusPane = (next) =>
      next ? setFocused(true) : transfer(() => setFocused(false));
    window.gate.visiblePane = (next) =>
      next ? setVisible(true) : transfer(() => setVisible(false));
    return () => {
      document.removeEventListener("focusin", recordFocus);
      document.removeEventListener("focusout", recordBlur);
    };
  }, []);
  return (
    <main>
      <div data-gate-pane-state data-focused={focused} data-visible={visible} />
      <SurfacePresentationBoundary visible={visible} focused={focused}>
        <PortalConcealmentBoundary concealed={concealed}>
          {coldActivation ? (
            <div
              onPointerDownCapture={activation.onPointerDownCapture}
              onPointerCancelCapture={activation.onPointerCancelCapture}
              onFocusCapture={activation.onFocusCapture}
            >
              {ownerOrNativeParity(foreignPaneTrigger ? paneBContainer : null)}
            </div>
          ) : (
            ownerOrNativeParity(foreignPaneTrigger ? paneBContainer : null)
          )}
        </PortalConcealmentBoundary>
      </SurfacePresentationBoundary>
      {/* Fixed to an uncovered corner - an open popup positions near its
          trigger and can otherwise overlap this button, blocking a real
          click's hit-test (R4's outside-click case needs a genuine click,
          not just a `.focus()` call). */}
      <button
        type="button"
        data-gate-outside
        style={{ position: "fixed", right: 16, bottom: 16 }}
      >
        Outside
      </button>
      {/* Plain, non-focusable background - the parity case's outside press
          lands here, not on any focusable control. */}
      <div data-gate-background style={{ height: "200vh" }}>
        Scrollable document
      </div>
      {/* Pane B: fixed to an uncovered corner, same reason as Outside above -
          the scrollable background otherwise pushes it below the viewport. */}
      {foreignPaneTrigger ? (
        <SurfacePresentationBoundary visible focused>
          <div
            ref={setPaneBContainer}
            data-gate-pane-b
            style={{ position: "fixed", top: 16, left: 16 }}
          />
        </SurfacePresentationBoundary>
      ) : null}
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
createRoot(container).render(<Fixture />);
