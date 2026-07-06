import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { RefreshCwIcon } from "lucide-react";
import { RemoveScroll } from "react-remove-scroll";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement,
} from "@floating-ui/dom";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  isArtifactMentionStep,
  mentionProviderRegistry,
  type MentionFlowStep,
} from "@/lib/composer/mentions";
import type { MentionPreview } from "@/lib/composer/types";
import { cn } from "@/lib/utils";

import {
  pickerItemPreview,
  type ComposerPickerItem,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

import { MentionMenuItem } from "./mention-menu-item";
import { MentionPreviewPanel } from "./mention-preview-panel";
import { SlashMenuItem } from "./slash-menu-item";
import { ZERO_DOM_RECT } from "./zero-dom-rect";

const SLASH_MENU_COPY = {
  header: "Slash commands",
  empty: "No matching commands",
};
const COMPOSER_ARTIFACT_REFRESH_TIMEOUT_MS = 10_000;

// Conservative bound for open-time placement decision; list is capped via
// max-h CSS so the rendered menu never exceeds this.
const MENU_HEIGHT_ESTIMATE = 280;

type LockedPlacement = Extract<Placement, "bottom-start" | "top-start">;

interface MenuSlice {
  readonly open: boolean;
  readonly kind: "mention" | "slash" | null;
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly step: MentionFlowStep;
}

function selectMenuSlice(state: {
  open: boolean;
  kind: "mention" | "slash" | null;
  items: ReadonlyArray<ComposerPickerItem>;
  activeIndex: number;
  loading: boolean;
  fetching: boolean;
  step: MentionFlowStep;
}): MenuSlice {
  return {
    open: state.open,
    kind: state.kind,
    items: state.items,
    activeIndex: state.activeIndex,
    loading: state.loading,
    fetching: state.fetching,
    step: state.step,
  };
}

export interface ComposerMenuProps {
  readonly pickerStore: ComposerPickerStore;
}

export function ComposerMenu(props: ComposerMenuProps) {
  const { pickerStore } = props;
  const slice = useStore(pickerStore, useShallow(selectMenuSlice));
  const { open, kind, items, activeIndex, loading, fetching, step } = slice;

  const baseMenuId = useId();
  const menuId = `${baseMenuId}-menu`;

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return (
    <ComposerMenuPortal
      pickerStore={pickerStore}
      kind={kind}
      items={items}
      activeIndex={activeIndex}
      loading={loading}
      fetching={fetching}
      step={step}
      menuId={menuId}
    />
  );
}

interface ComposerMenuPortalProps {
  readonly pickerStore: ComposerPickerStore;
  readonly kind: "mention" | "slash" | null;
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly step: MentionFlowStep;
  readonly menuId: string;
}

function ComposerMenuPortal(props: ComposerMenuPortalProps) {
  const {
    pickerStore,
    kind,
    items,
    activeIndex,
    loading,
    fetching,
    step,
    menuId,
  } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);

  const renderedItems = useMemo<ReadonlyArray<RenderedItem>>(
    () => items.map((item, index) => renderPickerItem(item, index, menuId)),
    [items, menuId],
  );

  const activePreview = useMemo<MentionPreview | null>(() => {
    if (activeIndex < 0 || activeIndex >= items.length) return null;
    return pickerItemPreview(items[activeIndex]);
  }, [items, activeIndex]);

  const copy = useMemo(() => {
    if (kind === "mention") return mentionProviderRegistry.menuCopy(step);
    if (kind === "slash") return SLASH_MENU_COPY;
    return SLASH_MENU_COPY;
  }, [kind, step]);

  const showEmptyLabelWithItems = useMemo(
    () =>
      kind === "mention" &&
      items.length === 1 &&
      items[0].kind === "mention" &&
      items[0].entry.action.kind === "back",
    [items, kind],
  );

  const refreshAvailable = kind === "mention" && isArtifactMentionStep(step);
  const refreshArtifacts = useCallback(() => {
    pickerStore.getState().setStep(step);
    return Promise.resolve();
  }, [pickerStore, step]);
  const artifactRefresh = useRefreshSpinner({
    onRefresh: refreshArtifacts,
    externalRefreshing: loading,
    timeoutMs: COMPOSER_ARTIFACT_REFRESH_TIMEOUT_MS,
  });

  // MentionPreviewPanel does its own pre-paint scrollIntoView for rows that
  // have a preview (see its layout effect), but it early-returns before
  // that when there's no preview - this passive effect is what still
  // scrolls the active row into view for those.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    if (active !== null) active.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Floating-ui positioning. The caret rect can be unavailable at open, so
  // recompute placement on each update and let flip handle viewport overflow.
  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null) return;

    const virtualReference = {
      getBoundingClientRect: (): DOMRect => {
        const rect = pickerStore.getState().clientRect?.() ?? null;
        return rect ?? ZERO_DOM_RECT;
      },
    };

    const reposition = (): void => {
      void computePosition(virtualReference, floating, {
        placement: selectInitialPlacement(pickerStore),
        middleware: [
          offset(6),
          flip({ padding: 8 }),
          shift({ mainAxis: false, crossAxis: true, padding: 8 }),
        ],
      }).then(({ x, y }) => {
        floating.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(
          y,
        )}px, 0)`;
      });
    };

    reposition();
    return autoUpdate(virtualReference, floating, reposition);
  }, [pickerStore]);

  const headerLabel = copy.header;
  const emptyLabel = copy.empty;
  const dialogContentShard = useMemo(() => activeDialogContentShard(), []);
  const removeScrollShards = useMemo(
    () => (dialogContentShard === null ? [] : [dialogContentShard]),
    [dialogContentShard],
  );
  const isolateOutsideScroll = dialogContentShard !== null;

  // The menu portals to `document.body`, so it lives OUTSIDE the Radix modal
  // Dialog's scroll-lock subtree (the Dialog's `react-remove-scroll` node and
  // its `contentRef` shard). That lock installs a document-level, non-passive
  // wheel/touch listener that `preventDefault()`s any scroll whose target is
  // neither the lock node nor a shard - so without intervention this list can't
  // scroll while the new-conversation modal is open. Giving the menu its own
  // lock pushes it to the top of react-remove-scroll's `lockStack` while open,
  // so its own overflow region is honored and the Dialog's lock is suspended -
  // the same way nested Radix modal popovers coexist with a modal Dialog.
  // When opened from inside a Dialog, the Dialog content is registered as a
  // shard so modal scroll containment still applies outside both the menu and
  // the modal content. Inline composers keep `noIsolation`, preserving their
  // background/page scroll behavior. `removeScrollBar={false}` avoids
  // re-managing the scrollbar the Dialog already owns.
  const menu = (
    <RemoveScroll
      ref={floatingRef}
      forwardProps
      enabled
      noIsolation={!isolateOutsideScroll}
      shards={removeScrollShards}
      removeScrollBar={false}
      allowPinchZoom
    >
      <div
        role="presentation"
        data-slot="composer-menu"
        // top-0/left-0 so floating-ui's translate3d is the source of truth.
        // Width fits content (w-max) so short menus stay compact and long command
        // names render in full, with a comfortable floor (min-w) and a
        // viewport-aware ceiling (max-w) past which items truncate. floating-ui's
        // shift() keeps the grown menu on-screen (CLAUDE.md sizing).
        className="pointer-events-auto fixed top-0 left-0 z-50 w-max min-w-[min(90vw,16rem)] max-w-[min(90vw,26rem)] overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-lg"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 truncate text-overline font-medium uppercase text-muted-foreground/70">
              {headerLabel}
            </div>
            {fetching && !loading ? (
              <AgentSpinningDots
                testId={undefined}
                variant={undefined}
                className="text-muted-foreground/60"
              />
            ) : null}
          </div>
          {refreshAvailable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh artifacts"
              title="Refresh artifacts"
              className="-my-1 text-muted-foreground/70 hover:text-foreground"
              disabled={artifactRefresh.refreshing}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={artifactRefresh.trigger}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  artifactRefresh.refreshing && "animate-spin",
                )}
              />
            </Button>
          ) : null}
        </div>
        <div
          ref={listRef}
          id={menuId}
          role="listbox"
          className="max-h-[min(50vh,12rem)] overflow-y-auto py-1"
        >
          <ComposerMenuBody
            renderedItems={renderedItems}
            loading={loading}
            emptyLabel={emptyLabel}
            showEmptyLabelWithItems={showEmptyLabelWithItems}
            activeIndex={activeIndex}
            pickerStore={pickerStore}
          />
        </div>
      </div>
    </RemoveScroll>
  );

  return (
    <>
      {createPortal(menu, document.body)}
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={activeIndex}
        preview={activePreview}
      />
    </>
  );
}

function selectInitialPlacement(store: ComposerPickerStore): LockedPlacement {
  const rect = store.getState().clientRect?.() ?? null;
  // No rect yet - fall back to bottom-start; autoUpdate will reposition once
  // the rect becomes available.
  if (rect === null) return "bottom-start";
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  if (spaceBelow >= MENU_HEIGHT_ESTIMATE) return "bottom-start";
  if (spaceAbove >= MENU_HEIGHT_ESTIMATE) return "top-start";
  return spaceBelow >= spaceAbove ? "bottom-start" : "top-start";
}

function activeDialogContentShard(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    const activeDialog = activeElement.closest<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    if (activeDialog !== null) return activeDialog;
  }

  const dialogs = document.querySelectorAll<HTMLElement>(
    '[data-slot="dialog-content"]',
  );
  if (dialogs.length === 0) return null;
  return dialogs[dialogs.length - 1];
}

interface RenderedItem {
  readonly id: string;
  readonly node: ReactNode;
}

function renderPickerItem(
  item: ComposerPickerItem,
  index: number,
  menuId: string,
): RenderedItem {
  if (item.kind === "mention") {
    return {
      id: `${menuId}-item-${index}`,
      node: <MentionMenuItem entry={item.entry} />,
    };
  }
  return {
    id: `${menuId}-item-${index}`,
    node: <SlashMenuItem command={item.command} />,
  };
}

interface ComposerMenuBodyProps {
  readonly renderedItems: ReadonlyArray<RenderedItem>;
  readonly loading: boolean;
  readonly emptyLabel: string;
  readonly showEmptyLabelWithItems: boolean;
  readonly activeIndex: number;
  readonly pickerStore: ComposerPickerStore;
}

function ComposerMenuBody(props: ComposerMenuBodyProps): ReactNode {
  const {
    renderedItems,
    loading,
    emptyLabel,
    showEmptyLabelWithItems,
    activeIndex,
    pickerStore,
  } = props;
  const loadingRow = (
    <div className="flex items-center gap-2 px-3 py-2 text-ui-xs text-muted-foreground/80">
      <AgentSpinningDots
        testId={undefined}
        variant="orbit"
        className="text-muted-foreground/80"
      />
      Loading…
    </div>
  );
  if (loading && renderedItems.length === 0) return loadingRow;
  if (renderedItems.length === 0) return emptyRow(emptyLabel, false);
  const rows = renderedItems.map((item, index) => {
    const isActive = index === activeIndex;
    return (
      <div
        key={item.id}
        id={item.id}
        role="option"
        tabIndex={-1}
        aria-selected={isActive}
        data-active={isActive}
        className={cn(
          "cursor-pointer px-2 py-0.5 text-ui-sm outline-none",
          isActive ? "bg-accent/60" : "hover:bg-accent/40",
        )}
        onMouseEnter={() => {
          pickerStore.getState().setActiveIndex(index);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          const state = pickerStore.getState();
          state.setActiveIndex(index);
          state.commitActiveItem();
        }}
      >
        {item.node}
      </div>
    );
  });
  if (loading) {
    return (
      <>
        {rows}
        {loadingRow}
      </>
    );
  }
  if (showEmptyLabelWithItems) {
    return (
      <>
        {rows}
        {emptyRow(emptyLabel, true)}
      </>
    );
  }
  return rows;
}

function emptyRow(emptyLabel: string, centered: boolean): ReactNode {
  return (
    <div
      className={cn(
        "px-3 py-2 text-ui-xs text-muted-foreground/80",
        centered ? "text-center" : undefined,
      )}
    >
      {emptyLabel}
    </div>
  );
}
