import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListFilter } from "lucide-react";
import { DraftRow } from "@/components/composer/drafts/draft-row";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useDraftInventory } from "@/hooks/drafts/use-draft-inventory";
import { useDraftInventoryActions } from "@/hooks/drafts/use-draft-inventory-actions";
import {
  draftRowSourceChip,
  neighbourRowId,
  resolveSelectedId,
  type DraftInventoryRow,
} from "@/lib/drafts/draft-inventory";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
  type AnalyticsDraftInput,
} from "@/lib/analytics";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import type { DraftsDialogEntryPoint } from "@/stores/dialogs/desktop-dialog-store";

interface DraftsFilter {
  readonly thisTask: boolean;
  readonly otherTasks: boolean;
  readonly startPages: boolean;
}

const ALL_DRAFTS: DraftsFilter = {
  thisTask: true,
  otherTasks: true,
  startPages: true,
};

/** Whether the filter lets this row through; `this task` needs an open task. */
function filterAllows(
  row: DraftInventoryRow,
  filter: DraftsFilter,
  activeEpicId: string | null,
): boolean {
  if (row.kind === "landing") return filter.startPages;
  return row.epicId === activeEpicId ? filter.thisTask : filter.otherTasks;
}

/** Mounted only while open, keeping keystroke subscriptions out of app chrome. */
export function DraftsDialog(props: {
  readonly hostId: string | null;
  readonly entryPoint: DraftsDialogEntryPoint;
  /** The epic of the active tab, or `null` outside a task. */
  readonly activeEpicId: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const { activeEpicId } = props;
  const rows = useDraftInventory(
    { surface: "landing", activeDraftId: null },
    "all",
  );
  const actions = useDraftInventoryActions(props.hostId, "avatar_menu");
  const openingRow = useRef(false);
  const recordedOpen = useRef(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(ALL_DRAFTS);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => {
    if (recordedOpen.current) return;
    recordedOpen.current = true;
    Analytics.getInstance().track(AnalyticsEvent.DraftsListOpened, {
      surface: "avatar_menu",
      entry_point: props.entryPoint,
      draft_count: analyticsCountBucket(rows.length),
    });
  }, [props.entryPoint, rows.length]);

  const query = search.trim().toLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      filterAllows(row, filter, activeEpicId) &&
      (query === "" ||
        row.preview.toLowerCase().includes(query) ||
        (draftRowSourceChip(row, activeEpicId, "all") ?? "")
          .toLowerCase()
          .includes(query)),
  );
  const selectedId = resolveSelectedId(visibleRows, highlightedId);
  const filtered =
    !filter.otherTasks ||
    !filter.startPages ||
    (activeEpicId !== null && !filter.thisTask);

  const changeFilter = (next: DraftsFilter) => {
    setFilter(next);
    Analytics.getInstance().track(AnalyticsEvent.DraftsFilterChanged, {
      surface: "avatar_menu",
      this_task: activeEpicId === null ? null : next.thisTask,
      other_tasks: next.otherTasks,
      start_pages: next.startPages,
    });
  };

  const openRow = (row: DraftInventoryRow, input: AnalyticsDraftInput) => {
    openingRow.current = true;
    useNewConversationModalOpenStore.getState().close();
    props.onClose();
    actions.openRow(row, input, query !== "");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[80dvh] flex-col overflow-hidden sm:max-w-2xl"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (openingRow.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Drafts</DialogTitle>
        </DialogHeader>
        <Command
          shouldFilter={false}
          loop
          variant="embedded"
          value={selectedId ?? ""}
          onValueChange={setHighlightedId}
          className="min-h-0 flex-1"
        >
          <div className="flex items-start pr-1">
            <div className="min-w-0 flex-1">
              <CommandInput
                placeholder="Search drafts"
                value={search}
                onValueChange={setSearch}
                onKeyDown={(event) => {
                  // Claimed before cmdk so the open is a keyboard one; cmdk
                  // skips a prevented event. A composing Enter is the IME's.
                  if (
                    event.key !== "Enter" ||
                    event.nativeEvent.isComposing ||
                    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Safari reports the IME-confirming Enter with isComposing already false; only keyCode 229 marks it, and there is no non-deprecated spelling
                    event.keyCode === 229
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const highlighted = visibleRows.find(
                    (row) => row.id === selectedId,
                  );
                  if (highlighted !== undefined) {
                    openRow(highlighted, "keyboard");
                  }
                }}
              />
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant={filtered ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label="Filter drafts"
                  className="mt-1.5"
                  // cmdk would take the Enter for the highlighted row.
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <ListFilter aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-auto"
                onKeyDown={(event) => event.stopPropagation()}
              >
                {activeEpicId === null ? null : (
                  <FilterOption
                    label="This task"
                    checked={filter.thisTask}
                    onChange={(thisTask) =>
                      changeFilter({ ...filter, thisTask })
                    }
                  />
                )}
                <FilterOption
                  label="Other tasks"
                  checked={filter.otherTasks}
                  onChange={(otherTasks) =>
                    changeFilter({ ...filter, otherTasks })
                  }
                />
                <FilterOption
                  label="Start pages"
                  checked={filter.startPages}
                  onChange={(startPages) =>
                    changeFilter({ ...filter, startPages })
                  }
                />
              </PopoverContent>
            </Popover>
          </div>
          <CommandList className="max-h-none min-h-0 flex-1">
            {visibleRows.length === 0 ? (
              <p className="py-6 text-center text-ui-sm text-muted-foreground">
                {rows.length === 0 ? "No drafts yet" : "No drafts match"}
              </p>
            ) : (
              <CommandGroup>
                {visibleRows.map((row) => (
                  <DraftRow
                    key={row.id}
                    row={row}
                    sourceChip={draftRowSourceChip(row, activeEpicId, "all")}
                    mobile
                    onHighlight={() => setHighlightedId(row.id)}
                    onOpen={(input) => openRow(row, input)}
                    onCopy={(input) => actions.copyRow(row, input)}
                    onDelete={(input) => {
                      setHighlightedId(neighbourRowId(visibleRows, row.id));
                      actions.deleteRow(row, input);
                    }}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function FilterOption(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-ui-sm">
      <Checkbox
        checked={props.checked}
        onCheckedChange={(value) => props.onChange(value === true)}
      />
      {props.label}
    </label>
  );
}
