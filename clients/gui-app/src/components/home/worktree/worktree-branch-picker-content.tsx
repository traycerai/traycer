import { useCallback, useEffect, type ReactNode, type RefObject } from "react";
import type { IndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import { Search } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  PickerActionButton,
  PickerOptionButton,
  PickerStateRow,
} from "@/components/home/worktree/worktree-branch-picker-options";
import {
  pickerElementId,
  pickerEntryId,
  type PickerEntry,
  type WorktreeBranchPickerContentProps,
  type WorktreeBranchPickerRow,
} from "@/components/home/worktree/worktree-branch-picker-model";

export function WorktreeBranchPickerContent(
  props: WorktreeBranchPickerContentProps,
) {
  const {
    actions,
    align,
    contentClassName,
    effectiveActiveEntryId,
    emptyLabel,
    filteredRows,
    handleCloseAutoFocus,
    handleContentKeyDown,
    hasQuery,
    idPrefix,
    initialTopMostItemIndex,
    inputRef,
    listboxId,
    listboxLabel,
    listKey,
    listRef,
    open,
    pinnedRows,
    portalContainer,
    query,
    resetQuery,
    searchPlaceholder,
    selectEntry,
    setActiveEntryId,
    setQuery,
    side,
  } = props;

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inputRef, open]);

  const computeResultRowKey = useCallback(
    (index: number, row: WorktreeBranchPickerRow | undefined) =>
      row?.id ?? `transient-row-${index}`,
    [],
  );

  const renderResultRow = useCallback(
    (index: number, row: WorktreeBranchPickerRow | undefined) => {
      if (row === undefined) return null;
      const entryId = pickerEntryId("result", row.id);
      return (
        <div className="py-0.5">
          <PickerOptionButton
            id={pickerElementId(idPrefix, entryId)}
            option={row}
            active={entryId === effectiveActiveEntryId}
            tabIndex={-1}
            onActive={() => setActiveEntryId(entryId)}
            onSelect={() =>
              selectEntry({
                kind: "result",
                id: entryId,
                row,
                rowIndex: index,
              })
            }
          />
        </div>
      );
    },
    [effectiveActiveEntryId, idPrefix, selectEntry, setActiveEntryId],
  );

  return (
    <PopoverContent
      side={side}
      align={align}
      sideOffset={0}
      container={portalContainer ?? undefined}
      collisionBoundary={portalContainer ?? undefined}
      collisionPadding={8}
      role="dialog"
      aria-label={listboxLabel}
      className={cn(
        "h-[min(var(--radix-popover-content-available-height),22rem)] w-[min(90vw,26rem)] min-w-(--radix-popover-trigger-width) gap-0 overflow-hidden rounded-xl p-0 data-[side=bottom]:rounded-t-none data-[side=top]:rounded-b-none",
        contentClassName,
      )}
      onKeyDown={handleContentKeyDown}
      onEscapeKeyDown={(event) => {
        if (!hasQuery) return;
        event.preventDefault();
        resetQuery();
      }}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <div className="shrink-0 border-b p-2">
        <InputGroup className="h-8! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
          <InputGroupInput
            ref={inputRef}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listboxId}
            aria-activedescendant={pickerElementId(
              idPrefix,
              effectiveActiveEntryId,
            )}
            className="text-ui-sm"
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
        </InputGroup>
      </div>
      <WorktreeBranchPickerListbox
        actions={actions}
        effectiveActiveEntryId={effectiveActiveEntryId}
        emptyLabel={emptyLabel}
        filteredRows={filteredRows}
        hasQuery={hasQuery}
        idPrefix={idPrefix}
        initialTopMostItemIndex={initialTopMostItemIndex}
        listboxId={listboxId}
        listboxLabel={listboxLabel}
        listKey={listKey}
        listRef={listRef}
        pinnedRows={pinnedRows}
        renderResultRow={renderResultRow}
        selectEntry={selectEntry}
        setActiveEntryId={setActiveEntryId}
        computeResultRowKey={computeResultRowKey}
      />
    </PopoverContent>
  );
}

interface WorktreeBranchPickerListboxProps {
  readonly actions: WorktreeBranchPickerContentProps["actions"];
  readonly computeResultRowKey: (
    index: number,
    row: WorktreeBranchPickerRow | undefined,
  ) => string;
  readonly effectiveActiveEntryId: string;
  readonly emptyLabel: string;
  readonly filteredRows: ReadonlyArray<WorktreeBranchPickerRow>;
  readonly hasQuery: boolean;
  readonly idPrefix: string;
  readonly initialTopMostItemIndex: IndexLocationWithAlign;
  readonly listboxId: string;
  readonly listboxLabel: string;
  readonly listKey: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly pinnedRows: WorktreeBranchPickerContentProps["pinnedRows"];
  readonly renderResultRow: (
    index: number,
    row: WorktreeBranchPickerRow | undefined,
  ) => ReactNode;
  readonly selectEntry: WorktreeBranchPickerContentProps["selectEntry"];
  readonly setActiveEntryId: (entryId: string) => void;
}

function WorktreeBranchPickerListbox(props: WorktreeBranchPickerListboxProps) {
  const {
    actions,
    computeResultRowKey,
    effectiveActiveEntryId,
    emptyLabel,
    filteredRows,
    hasQuery,
    idPrefix,
    initialTopMostItemIndex,
    listboxId,
    listboxLabel,
    listKey,
    listRef,
    pinnedRows,
    renderResultRow,
    selectEntry,
    setActiveEntryId,
  } = props;
  return (
    // oxlint-disable-next-line react-doctor/prefer-tag-over-role -- Native datalist cannot represent this virtualized picker with pinned rows, disabled tooltips, and command actions.
    <div
      id={listboxId}
      role="listbox"
      aria-label={listboxLabel}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {pinnedRows.length === 0 ? null : (
        <div className="shrink-0 border-b p-1">
          {pinnedRows.map((option) => {
            const entryId = pickerEntryId("pinned", option.id);
            return (
              <PickerOptionButton
                key={option.id}
                id={pickerElementId(idPrefix, entryId)}
                option={option}
                active={entryId === effectiveActiveEntryId}
                tabIndex={-1}
                onActive={() => setActiveEntryId(entryId)}
                onSelect={() =>
                  selectEntry({
                    kind: "pinned",
                    id: entryId,
                    option,
                  })
                }
              />
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden p-1">
        {filteredRows.length === 0 ? (
          <PickerStateRow
            label={hasQuery ? "No matching branches" : emptyLabel}
          />
        ) : (
          <Virtuoso<WorktreeBranchPickerRow>
            key={listKey}
            ref={listRef}
            className="h-full overscroll-contain"
            data={filteredRows}
            computeItemKey={computeResultRowKey}
            defaultItemHeight={48}
            increaseViewportBy={120}
            initialTopMostItemIndex={initialTopMostItemIndex}
            itemContent={renderResultRow}
          />
        )}
      </div>
      {actions.length === 0 ? null : (
        <div className="shrink-0 border-t p-1">
          {actions.map((action) => {
            const entryId = pickerEntryId("action", action.id);
            const entry: PickerEntry = {
              kind: "action",
              id: entryId,
              action,
            };
            return (
              <PickerActionButton
                key={action.id}
                id={pickerElementId(idPrefix, entryId)}
                action={action}
                active={entryId === effectiveActiveEntryId}
                onActive={() => setActiveEntryId(entryId)}
                onSelect={() => selectEntry(entry)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
