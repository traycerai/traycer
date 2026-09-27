import { LayoutUsageProvider } from "@/components/layout-editor/inspector/provider-limit-windows";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "@/components/layout-editor/layout-editor.css";
import { installEditFirewall } from "@/components/layout-editor/canvas/edit-firewall";
import {
  cancelLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";
import { useLayoutCanvas } from "@/components/layout-editor/canvas/layout-canvas";
import { useFloatingDock } from "@/components/layout-editor/inspector/dock-modes";
import { InspectorShell } from "@/components/layout-editor/inspector/inspector-shell";
import {
  LayoutAllSettings,
  LayoutAreaLevel,
} from "@/components/layout-editor/inspector/layout-form";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { SessionReviewLevel } from "@/components/layout-editor/inspector/session-changes";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import { SurfacePlacementBar } from "@/components/layout-editor/surface-placement-bar";
import { TooltipsSuppressedProvider } from "@/components/ui/tooltip-wrapper";
import {
  initializeLayoutEditorWindow,
  watchLayoutEditorLease,
} from "@/lib/layout/editor-lease";
import { setLayoutInspectorNode } from "@/lib/layout/editor-motion";
import {
  abandonLayoutEditorSession,
  closeLayoutEditor,
} from "@/lib/layout/editor-session";
import { useDesktopWindowId } from "@/lib/windows/desktop-window-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

interface LayoutEditorProps {
  /**
   * The app column (4.5): the element the canvas decorates, the firewall sits
   * on, and this inspector is a SIBLING of. `null` before the shell's ref has
   * landed, which is the first render only.
   */
  readonly column: HTMLElement | null;
}

/**
 * The mounted editor: the canvas controllers, the edit firewall, and the
 * inspector docked beside the app (L-01, L-05).
 *
 * Mounted unconditionally by `app-shell.tsx` and inert until a session opens -
 * `useLayoutCanvas` does nothing without one, and this renders nothing. The
 * door itself is `lib/layout/editor-session.ts`; nothing here decides whether
 * the editor should be open, only what being open looks like.
 */
export function LayoutEditor(props: LayoutEditorProps): ReactNode {
  const { column } = props;
  const live = useLayoutEditorStore((state) => state.session !== null);
  const dockMode = useLayoutEditorStore((state) => state.dockMode);
  const windowId = useDesktopWindowId();
  const [inspector, setInspector] = useState<HTMLDivElement | null>(null);
  const floatPosition = useFloatingDock(inspector);

  // The panel is this file's markup, so the door is HANDED it rather than
  // going looking for it: `editor-motion.ts` animates the exit on this node.
  const bindInspector = useCallback((node: HTMLDivElement | null) => {
    setInspector(node);
    setLayoutInspectorNode(node);
  }, []);

  // Unconditional, with the column: the hook sets and removes
  // `data-layout-editing` itself, so the attribute can never outlive a session.
  useLayoutCanvas(column);

  useEffect(() => {
    initializeLayoutEditorWindow(windowId);
  }, [windowId]);

  // One window holds the editor open (L-32). Watched for the whole life of the
  // shell rather than per session, because the lease that matters here is the
  // one ANOTHER window took while this one was not looking.
  useEffect(
    () =>
      watchLayoutEditorLease(() => {
        closeLayoutEditor("lease-lost");
      }),
    [],
  );

  // The shell going away is a different concern from another window's lease,
  // and it does not go through the door's motion: a sign-out or a window
  // teardown has no document left to glide and no inspector left to slide out.
  useEffect(
    () => () => {
      abandonLayoutEditorSession();
    },
    [],
  );

  useEffect(() => {
    if (!live || column === null || inspector === null) return;
    return installEditFirewall({
      column,
      focusTarget: () =>
        inspector.querySelector<HTMLElement>("[data-layout-inspector-shell]"),
    });
  }, [live, column, inspector]);

  // Undo and Redo live on the editor, not on whatever has focus: every gesture
  // in a session is one step on the same stack (L-18). Deliberately not
  // exempting text fields - the only field in the editor is the region filter,
  // and inside the editor Mod+Z means the layout.
  useEffect(() => {
    if (!live) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      const state = useLayoutEditorStore.getState();
      if (event.shiftKey) state.redo();
      else state.undo();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [live]);

  // Escape's one owner while a session is live, for the same reason as the
  // chord above: the ladder is a fact about the SESSION, not about what has
  // focus. Cancel a drag, close the open rows, step back to All settings, then
  // stop: Escape never closes the editor (audit F5, narrowing L-31). Done and
  // Cmd+W do. The filter's clear and the sortable list's grab-cancel stop the
  // native event below this node, and a layer that took focus answers for
  // itself (see `ownsItsOwnEscape`).
  useEffect(() => {
    if (!live) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (ownsItsOwnEscape(event.target)) return;
      if (layoutDragActive()) {
        event.preventDefault();
        cancelLayoutDrag();
        return;
      }
      if (useLayoutEditorStore.getState().popInspectorLevel())
        event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [live]);

  if (!live) return null;

  return (
    <div
      ref={bindInspector}
      data-layout-inspector
      data-dock-mode={dockMode}
      style={
        dockMode === "float"
          ? {
              transform: `translate3d(${floatPosition.x}px, ${floatPosition.y}px, 0)`,
            }
          : undefined
      }
      className="h-safe-dvh"
    >
      {/* Which host is drawing the form, published ONCE at the root of it
        (L-03) - the same place and the same way `layout-settings-panel.tsx`
        publishes `"page"`. It used to ride on `RegionSection`'s own `host`
        prop, which only ever arrived here and only ever said `"inspector"`,
        so the prop carried a branch the page never took. */}
      {/* The panel's own controls are real controls, so their hover labels
        open. `SampleSceneProvider` suppresses tooltips for the whole shell
        while a session is live - the canvas is a picture of the app and a
        label over it covers the hover chip - and it cannot exclude this
        panel, which is a DOM sibling of the column but a React descendant of
        that provider. Published beside the form host for the same reason it
        is: once, at the root of the inspector. */}
      <TooltipsSuppressedProvider value={false}>
        <LayoutFormHostContext value="inspector">
          <LayoutUsageProvider>
            <InspectorBody />
          </LayoutUsageProvider>
        </LayoutFormHostContext>
        {/* Portalled over the canvas, but a React child here so its labels
          open like the panel's own. */}
        <SurfacePlacementBar />
      </TooltipsSuppressedProvider>
    </div>
  );
}

/**
 * Which level the inspector shows: All settings, the area the editor store
 * has open (`openArea`, or a canvas selection), or the session's change list
 * over either.
 *
 * Separate from the root so that none of it - least of all the notification
 * feed the relay row reads - is subscribed to while the editor is closed.
 */
function InspectorBody(): ReactNode {
  const area = useLayoutEditorStore((state) => state.area);
  const reviewing = useLayoutEditorStore((state) => state.reviewingSession);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [leftArea, setLeftArea] = useState(area);
  const reviewedRef = useRef(reviewing);

  // Back from the session's change list, focus lands on the Review that
  // opened it, which comes back as the list goes. Only when focus went down
  // with the list: leaving it for an area mounts that level's back row, which
  // has already taken focus by the time this runs.
  useEffect(() => {
    const left = reviewedRef.current && !reviewing;
    reviewedRef.current = reviewing;
    if (!left) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    rootRef.current
      ?.closest("[data-layout-inspector-shell]")
      ?.querySelector<HTMLElement>("[data-session-review-trigger]")
      ?.focus();
  }, [reviewing]);

  // Back at All settings, focus lands on the area row the user left, so the
  // keyboard is where the eye is. Tracked during render (the previous area is
  // gone by the time an effect could read it).
  if (leftArea !== area && area !== null) setLeftArea(area);
  useEffect(() => {
    if (area !== null || leftArea === null) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-layout-area="${leftArea}"]`)
      ?.focus();
  }, [area, leftArea]);

  return (
    <InspectorShell onExit={closeLayoutEditor}>
      <div ref={rootRef}>
        <InspectorLevel reviewing={reviewing} area={area} />
      </div>
    </InspectorShell>
  );
}

function InspectorLevel(props: {
  readonly reviewing: boolean;
  readonly area: SurfaceGroupId | null;
}): ReactNode {
  const { reviewing, area } = props;
  if (reviewing) return <SessionReviewLevel />;
  if (area === null) return <LayoutAllSettings />;
  // Keyed on the area, so arriving at one re-homes focus onto its back row
  // rather than leaving it on the row that opened it.
  return <LayoutAreaLevel key={area} area={area} />;
}

/**
 * An open overlay owns Escape for its own layer.
 *
 * A Radix layer that has taken focus - the canvas's own quick-verb context
 * menu, a dialog, a popover - dismisses itself on Escape, and a ladder step in
 * the same press would close the menu AND leave the level the user was
 * reading. Read off the event's target rather than off a layer count, because
 * this listener is installed when the session opens and a layer that mounts
 * later is dismissed AFTER it, so `defaultPrevented` alone answers too late.
 */
function ownsItsOwnEscape(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      '[data-radix-popper-content-wrapper],[role="dialog"],[role="menu"],[role="listbox"]',
    ) !== null
  );
}
