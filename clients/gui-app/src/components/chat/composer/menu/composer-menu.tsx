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
  activePickerItemDisabledReason,
  pickerItemDisabledReason,
  pickerItemPreview,
  type ComposerPickerItem,
  type ComposerPickerStore,
  type ComposerSlashTrigger,
} from "../picker/composer-picker-store";

import { MentionMenuItem } from "./mention-menu-item";
import { MentionPreviewPanel } from "./mention-preview-panel";
import { SlashMenuItem } from "./slash-menu-item";
import { ZERO_DOM_RECT } from "./zero-dom-rect";

const SLASH_MENU_COPY = {
  header: "Slash commands",
  empty: "No matching commands",
};
const LOAD_FAILED_LABEL = "Couldn't load commands";
const COMPOSER_ARTIFACT_REFRESH_TIMEOUT_MS = 10_000;

// Conservative bound for open-time placement decision; list is capped via
// max-h CSS so the rendered menu never exceeds this.
const MENU_HEIGHT_ESTIMATE = 280;

type LockedPlacement = Extract<Placement, "bottom-start" | "top-start">;

interface MenuSlice {
  readonly open: boolean;
  readonly kind: "mention" | "slash" | null;
  readonly slashTrigger: ComposerSlashTrigger | null;
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly loadFailed: boolean;
  readonly step: MentionFlowStep;
}

function selectMenuSlice(state: {
  open: boolean;
  kind: "mention" | "slash" | null;
  slashTrigger: ComposerSlashTrigger | null;
  items: ReadonlyArray<ComposerPickerItem>;
  activeIndex: number;
  loading: boolean;
  fetching: boolean;
  loadFailed: boolean;
  step: MentionFlowStep;
}): MenuSlice {
  return {
    open: state.open,
    kind: state.kind,
    slashTrigger: state.slashTrigger,
    items: state.items,
    activeIndex: state.activeIndex,
    loading: state.loading,
    fetching: state.fetching,
    loadFailed: state.loadFailed,
    step: state.step,
  };
}

export interface ComposerMenuProps {
  readonly pickerStore: ComposerPickerStore;
}

export function ComposerMenu(props: ComposerMenuProps) {
  const { pickerStore } = props;
  const slice = useStore(pickerStore, useShallow(selectMenuSlice));
  const {
    open,
    kind,
    slashTrigger,
    items,
    activeIndex,
    loading,
    fetching,
    loadFailed,
    step,
  } = slice;

  const baseMenuId = useId();
  const menuId = `${baseMenuId}-menu`;

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return (
    <ComposerMenuPortal
      pickerStore={pickerStore}
      kind={kind}
      slashTrigger={slashTrigger}
      items={items}
      activeIndex={activeIndex}
      loading={loading}
      fetching={fetching}
      loadFailed={loadFailed}
      step={step}
      menuId={menuId}
    />
  );
}

interface ComposerMenuPortalProps {
  readonly pickerStore: ComposerPickerStore;
  readonly kind: "mention" | "slash" | null;
  readonly slashTrigger: ComposerSlashTrigger | null;
  readonly items: ReadonlyArray<ComposerPickerItem>;
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly loadFailed: boolean;
  readonly step: MentionFlowStep;
  readonly menuId: string;
}

function ComposerMenuPortal(props: ComposerMenuPortalProps) {
  const {
    pickerStore,
    kind,
    slashTrigger,
    items,
    activeIndex,
    loading,
    fetching,
    loadFailed,
    step,
    menuId,
  } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);

  const renderedItems = useMemo<ReadonlyArray<RenderedItem>>(
    () =>
      items.map((item, index) =>
        renderPickerItem(item, index, menuId, slashTrigger ?? "/"),
      ),
    [items, menuId, slashTrigger],
  );

  const activePreview = useMemo<MentionPreview | null>(() => {
    if (activeIndex < 0 || activeIndex >= items.length) return null;
    return pickerItemPreview(items[activeIndex]);
  }, [items, activeIndex]);

  const activeDisabledReason = useMemo<string | null>(
    () => activePickerItemDisabledReason({ items, activeIndex }),
    [items, activeIndex],
  );

  const copy = useMemo(() => {
    if (kind === "mention") return mentionProviderRegistry.menuCopy(step);
    // Both triggers list the same catalog, so the header does not vary with the
    // trigger - only the row prefixes echo which character was typed.
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
    () =>
      dialogContentShard === null
        ? [previewPanelRef]
        : [dialogContentShard, previewPanelRef],
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
            loadFailed={loadFailed}
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
        panelRef={previewPanelRef}
        listRef={listRef}
        activeIndex={activeIndex}
        preview={activePreview}
        disabledReason={activeDisabledReason}
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
  readonly disabledReason: string | null;
}

function renderPickerItem(
  item: ComposerPickerItem,
  index: number,
  menuId: string,
  trigger: ComposerSlashTrigger,
): RenderedItem {
  if (item.kind === "mention") {
    return {
      id: `${menuId}-item-${index}`,
      node: <MentionMenuItem entry={item.entry} />,
      disabledReason: null,
    };
  }
  return {
    id: `${menuId}-item-${index}`,
    node: <SlashMenuItem command={item.command} trigger={trigger} />,
    disabledReason: pickerItemDisabledReason(item),
  };
}

/**
 * Inert rows still take the highlight as you arrow past them - skipping them
 * makes the selection look like it teleports - but at a weaker weight so
 * "selected" never reads as "actionable".
 */
function rowHighlightClass(isActive: boolean, disabled: boolean): string {
  if (!isActive) return "hover:bg-accent/40";
  return disabled ? "bg-accent/25" : "bg-accent/60";
}

interface ComposerMenuBodyProps {
  readonly renderedItems: ReadonlyArray<RenderedItem>;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly emptyLabel: string;
  readonly showEmptyLabelWithItems: boolean;
  readonly activeIndex: number;
  readonly pickerStore: ComposerPickerStore;
}

function ComposerMenuBody(props: ComposerMenuBodyProps): ReactNode {
  const {
    renderedItems,
    loading,
    loadFailed,
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
  // A failed catalog load with nothing to show is an error state, not an
  // empty result - "No matching commands" would misreport a provider failure
  // as a legitimately empty catalog.
  if (loadFailed && renderedItems.length === 0) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-ui-xs text-muted-foreground/80">
        <span className="min-w-0 truncate">{LOAD_FAILED_LABEL}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-my-1 shrink-0 text-muted-foreground/70 hover:text-foreground"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            pickerStore.getState().retryLoad?.();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (renderedItems.length === 0) return emptyRow(emptyLabel, false);
  const rows = renderedItems.map((item, index) => {
    const disabled = item.disabledReason !== null;
    const isActive = index === activeIndex;
    return (
      <div
        key={item.id}
        id={item.id}
        role="option"
        tabIndex={-1}
        aria-selected={isActive}
        aria-disabled={disabled}
        data-active={isActive}
        data-disabled={disabled}
        className={cn(
          "px-2 py-0.5 text-ui-sm outline-none",
          disabled ? "cursor-default opacity-50" : "cursor-pointer",
          rowHighlightClass(isActive, disabled),
        )}
        onMouseEnter={() => {
          pickerStore.getState().setActiveIndex(index);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          if (disabled) return;
          const state = pickerStore.getState();
          state.setActiveIndex(index);
          state.commitActiveItem();
        }}
      >
        {item.node}
        {item.disabledReason === null ? null : (
          // `aria-disabled` says a row is unavailable but never why, and the
          // preview panel that carries the reason is `aria-hidden` and drops
          // out of view entirely when it cannot fit. Without this the reason
          // reaches no screen reader at all.
          <span className="sr-only">{`Disabled. ${item.disabledReason}`}</span>
        )}
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
