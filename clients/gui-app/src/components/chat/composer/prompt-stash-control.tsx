import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { AlertTriangle, Bookmark, Copy } from "lucide-react";
import { toast } from "sonner";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { PromptStashController } from "@/hooks/composer/use-prompt-stash";
import {
  promptStashRowId,
  type PromptStashEntry,
} from "@/lib/composer/prompt-stash-codec";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useStore } from "zustand";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";
import { ComposerContentPreview } from "@/components/chat/composer/composer-content-preview";

interface PromptStashControlProps {
  readonly controller: PromptStashController;
  readonly pickerStore: ComposerPickerStore;
}

function firstRowId(rows: PromptStashController["rows"]): string | null {
  const first = rows.at(0);
  return first === undefined ? null : promptStashRowId(first);
}

function computeNextRowIndex(args: {
  readonly currentIndex: number;
  readonly direction: "up" | "down";
  readonly length: number;
}): number {
  const offset = args.direction === "down" ? 1 : -1;
  const fallbackIndex = offset === 1 ? -1 : 0;
  return (
    ((args.currentIndex < 0 ? fallbackIndex : args.currentIndex) +
      offset +
      args.length) %
    args.length
  );
}

function isPlainPrintableKeydown(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
  );
}

function isBareDeleteKeyWithSelection(
  event: KeyboardEvent,
  hasSelectedRow: boolean,
): boolean {
  return event.key.toLowerCase() === "d" && !event.shiftKey && hasSelectedRow;
}

function keydownTargetsDeleteButton(event: KeyboardEvent): boolean {
  return (
    event.target instanceof HTMLElement &&
    event.target.closest('button[aria-label="Delete stashed prompt"]') !== null
  );
}

function promptStashTriggerLabel(rowCount: number): string {
  if (rowCount === 0) return "Stashing prompt";
  return `Stashed prompts: ${String(rowCount)}. Open stash.`;
}

function PromptStashTriggerButton(props: {
  readonly open: boolean;
  readonly saving: boolean;
  readonly rowCount: number;
  readonly pulseEpoch: number;
}) {
  const { open, saving, rowCount, pulseEpoch } = props;
  return (
    <div data-composer-utility-rail="" className="relative shrink-0">
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={promptStashTriggerLabel(rowCount)}
          disabled={rowCount === 0}
          className={cn(
            "rounded-full bg-background/95 px-2.5 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground",
            open && "text-foreground",
          )}
          onPointerDown={(event) => event.preventDefault()}
        >
          {saving ? (
            <AgentSpinningDots
              className="size-3.5"
              testId="prompt-stash-saving"
              variant={undefined}
            />
          ) : (
            <Bookmark className="size-3.5" aria-hidden />
          )}
          <span>{rowCount === 0 ? "Stashing" : "Stash"}</span>
          {rowCount === 0 ? null : (
            <span
              key={pulseEpoch}
              className={cn(
                "rounded-full bg-muted px-1.5 font-medium tabular-nums",
                pulseEpoch > 0 && "prompt-stash-count-flash",
              )}
            >
              {rowCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
    </div>
  );
}

function PromptStashControlImpl(props: PromptStashControlProps) {
  const {
    rows,
    busyEntryId,
    saving,
    pulseEpoch,
    menuOpen,
    setMenuOpen: setControllerMenuOpen,
    editorHasFocus,
    focusEditor,
    restore: restoreEntry,
    remove,
  } = props.controller;
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const restoreEditorFocusRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pickerOpen = useStore(props.pickerStore, (state) => state.open);
  const open = menuOpen && rows.length > 0;
  const highlightedRowExists =
    highlightedId !== null &&
    rows.some((row) => promptStashRowId(row) === highlightedId);
  const selectedId = highlightedRowExists ? highlightedId : firstRowId(rows);
  const selectedRow = rows.find((row) => promptStashRowId(row) === selectedId);
  const hasSelectedRow = selectedRow !== undefined;

  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        restoreEditorFocusRef.current = editorHasFocus();
        setControllerMenuOpen(true);
        return;
      }
      setControllerMenuOpen(false);
    },
    [editorHasFocus, setControllerMenuOpen],
  );

  useEffect(() => {
    if (!menuOpen || rows.length > 0) return;
    setControllerMenuOpen(false);
    focusEditor();
  }, [rows.length, focusEditor, menuOpen, setControllerMenuOpen]);

  useEffect(() => {
    if (pickerOpen) setMenuOpen(false);
  }, [pickerOpen, setMenuOpen]);

  const restore = useCallback(
    async (entry: PromptStashEntry) => {
      if (await restoreEntry(entry)) {
        restoreEditorFocusRef.current = true;
        setMenuOpen(false);
      }
    },
    [restoreEntry, setMenuOpen],
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      const shouldRestoreEditorFocus = restoreEditorFocusRef.current;
      restoreEditorFocusRef.current = false;
      if (shouldRestoreEditorFocus) focusEditor();
    },
    [focusEditor],
  );

  const scrollEntryIntoView = useCallback((entryId: string) => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const rowElements =
        listRef.current?.querySelectorAll<HTMLElement>(
          "[data-prompt-stash-id]",
        ) ?? [];
      const rowElement = Array.from(rowElements).find(
        (candidate) => candidate.dataset.promptStashId === entryId,
      );
      rowElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, []);
  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  const claimDeleteKey = useBareKeyClaimer("d", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectedRow === undefined || busyEntryId !== null) return;
    void remove(promptStashRowId(selectedRow));
  });
  useEffect(
    () => (open && hasSelectedRow ? claimDeleteKey() : undefined),
    [claimDeleteKey, hasSelectedRow, open],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (rows.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = rows.findIndex(
          (row) => promptStashRowId(row) === selectedId,
        );
        const nextIndex = computeNextRowIndex({
          currentIndex,
          direction: event.key === "ArrowDown" ? "down" : "up",
          length: rows.length,
        });
        const nextRow = rows.at(nextIndex);
        if (nextRow === undefined) return;
        setHighlightedId(promptStashRowId(nextRow));
        scrollEntryIntoView(promptStashRowId(nextRow));
        return;
      }
      if (isPlainPrintableKeydown(event)) {
        if (isBareDeleteKeyWithSelection(event, selectedRow !== undefined)) {
          return;
        }
        setMenuOpen(false);
        return;
      }
      const highlighted = rows.find(
        (row) => promptStashRowId(row) === selectedId,
      );
      if (highlighted === undefined) return;
      if (event.key === "Enter") {
        if (keydownTargetsDeleteButton(event)) return;
        event.preventDefault();
        event.stopPropagation();
        // Unavailable rows have no Insert action, but the event is still
        // consumed here (not just no-restored) - the popover intentionally
        // keeps editor focus, so an uncaught Enter would fall through to the
        // still-focused editor and could submit it.
        if (highlighted.kind === "entry") {
          void restore(highlighted.entry);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    rows,
    open,
    remove,
    restore,
    scrollEntryIntoView,
    selectedRow,
    selectedId,
    setMenuOpen,
  ]);

  if (rows.length === 0 && !saving) return null;

  return (
    <Popover open={open} onOpenChange={setMenuOpen}>
      <PromptStashTriggerButton
        open={open}
        saving={saving}
        rowCount={rows.length}
        pulseEpoch={pulseEpoch}
      />
      {open ? (
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className="max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[calc(100vw-2rem)] max-w-lg gap-0 overflow-hidden p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <Command
            loop
            value={selectedId ?? ""}
            onValueChange={setHighlightedId}
            className="max-h-full min-h-0 rounded-lg bg-transparent p-0"
          >
            <div className="flex h-8 items-center gap-1.5 border-b border-border/60 px-2.5 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Bookmark className="size-3" aria-hidden />
              <span>Stashed prompts</span>
            </div>
            <CommandList ref={listRef} className="min-h-0 max-h-none">
              <CommandGroup className="p-1">
                {rows.map((row) =>
                  row.kind === "entry" ? (
                    <PromptStashEntryRowView
                      key={row.entry.id}
                      entry={row.entry}
                      busy={busyEntryId === row.entry.id}
                      onHighlight={() => setHighlightedId(row.entry.id)}
                      onRestore={() => void restore(row.entry)}
                      onDelete={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void remove(row.entry.id);
                      }}
                    />
                  ) : (
                    <PromptStashUnavailableRowView
                      key={row.id}
                      id={row.id}
                      createdAt={row.createdAt}
                      content={row.content}
                      busy={busyEntryId === row.id}
                      onHighlight={() => setHighlightedId(row.id)}
                      onDelete={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void remove(row.id);
                      }}
                    />
                  ),
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function PromptStashEntryRowView(props: {
  readonly entry: PromptStashEntry;
  readonly busy: boolean;
  readonly onHighlight: () => void;
  readonly onRestore: () => void;
  readonly onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const relative = useRelativeTimestamp(props.entry.createdAt);
  return (
    <CommandItem
      value={props.entry.id}
      data-prompt-stash-id={props.entry.id}
      disabled={props.busy}
      className="group/stash grid min-h-9 cursor-pointer grid-cols-[minmax(0,1fr)_9rem] items-start gap-1.5 overflow-hidden rounded-md px-2 py-1.5 [&>svg:last-child]:hidden"
      onPointerDown={(event) => event.preventDefault()}
      onMouseMove={props.onHighlight}
      onSelect={props.onRestore}
    >
      <div
        data-slot="prompt-stash-row-preview"
        className="max-h-[2lh] min-w-0 overflow-hidden text-ui-sm leading-5 wrap-break-word"
      >
        <ComposerContentPreview
          content={props.entry.content}
          emptyLabel="Stashed prompt"
          testId="prompt-stash-content-preview"
          className="leading-5"
        />
      </div>
      <PromptStashRowMetadata>
        <span>{relative}</span>
      </PromptStashRowMetadata>
      <PromptStashRowActions>
        <div className="pointer-events-auto inline-flex items-center gap-0.5">
          {props.busy ? (
            <AgentSpinningDots
              className="size-3.5"
              testId="prompt-stash-entry-pending"
              variant={undefined}
            />
          ) : (
            <>
              <button
                type="button"
                aria-label="Insert stashed prompt"
                aria-keyshortcuts="Enter"
                className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onRestore();
                }}
              >
                <span>Insert</span>
                <Kbd className="h-4 min-w-4 rounded px-1 font-mono text-[10px]">
                  ↵
                </Kbd>
              </button>
              <button
                type="button"
                aria-label="Delete stashed prompt"
                aria-keyshortcuts="D"
                className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={props.onDelete}
              >
                <span>Delete</span>
                <Kbd className="h-4 min-w-4 rounded px-1 font-mono text-[10px]">
                  D
                </Kbd>
              </button>
            </>
          )}
        </div>
      </PromptStashRowActions>
    </CommandItem>
  );
}

function PromptStashRowMetadata(props: { readonly children: ReactNode }) {
  return (
    <div
      data-slot="prompt-stash-row-metadata"
      className="pointer-events-none col-start-2 row-start-1 flex h-6 w-full items-center justify-end gap-1 text-[11px] leading-none text-muted-foreground transition-opacity group-hover/stash:opacity-0 group-focus-within/stash:opacity-0 group-data-selected/stash:opacity-0"
    >
      {props.children}
    </div>
  );
}

function PromptStashRowActions(props: { readonly children: ReactNode }) {
  return (
    <div
      data-slot="prompt-stash-row-actions"
      className="pointer-events-none col-start-2 row-start-1 flex h-6 w-full items-center justify-end opacity-0 transition-opacity duration-150 group-hover/stash:opacity-100 group-focus-within/stash:opacity-100 group-data-selected/stash:opacity-100"
    >
      {props.children}
    </div>
  );
}

/**
 * A row whose entry failed validation (malformed shape) or whose blob(s)
 * are missing/damaged - see `PromptStashUnavailableRow`. Never restorable:
 * no Insert affordance. Offers explicit delete (always) and a best-effort
 * copy-text affordance (only when the record's own content still parsed
 * enough to extract text from) - the row stays visible and actionable
 * rather than disappearing or silently trying to insert broken content.
 */
function PromptStashUnavailableRowView(props: {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent | null;
  readonly busy: boolean;
  readonly onHighlight: () => void;
  readonly onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const relative = useRelativeTimestamp(props.createdAt);
  const recoverableText =
    props.content === null
      ? ""
      : extractPlainTextFromComposerJSONContent(props.content)
          .trim()
          .replace(/\s+/g, " ");
  const { copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: () => toast.success("Copied stashed text"),
    onError: () =>
      toast.error("Could not copy text", {
        description: "Try selecting and copying it manually instead.",
      }),
  });
  return (
    <CommandItem
      value={props.id}
      data-prompt-stash-id={props.id}
      disabled={props.busy}
      className="group/stash grid min-h-9 cursor-default grid-cols-[minmax(0,1fr)_9rem] items-start gap-1.5 overflow-hidden rounded-md px-2 py-1.5 opacity-70 [&>svg:last-child]:hidden"
      onPointerDown={(event) => event.preventDefault()}
      onMouseMove={props.onHighlight}
      onSelect={() => undefined}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span
          data-slot="prompt-stash-row-preview"
          className="line-clamp-2 min-w-0 flex-1 whitespace-normal break-words text-ui-sm leading-5 text-muted-foreground"
        >
          {recoverableText.length === 0
            ? "Unavailable - this stashed prompt could not be restored."
            : recoverableText}
        </span>
      </div>
      <PromptStashRowMetadata>
        <span>{relative}</span>
      </PromptStashRowMetadata>
      <PromptStashRowActions>
        <div className="pointer-events-auto inline-flex items-center gap-0.5">
          {props.busy ? (
            <AgentSpinningDots
              className="size-3.5"
              testId="prompt-stash-entry-pending"
              variant={undefined}
            />
          ) : (
            <>
              {recoverableText.length === 0 ? null : (
                <button
                  type="button"
                  aria-label="Copy stashed text"
                  className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    copy(recoverableText);
                  }}
                >
                  <Copy className="size-3" aria-hidden />
                  <span>Copy</span>
                </button>
              )}
              <button
                type="button"
                aria-label="Delete stashed prompt"
                aria-keyshortcuts="D"
                className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={props.onDelete}
              >
                <span>Delete</span>
                <Kbd className="h-4 min-w-4 rounded px-1 font-mono text-[10px]">
                  D
                </Kbd>
              </button>
            </>
          )}
        </div>
      </PromptStashRowActions>
    </CommandItem>
  );
}

export const PromptStashControl = memo(PromptStashControlImpl);
