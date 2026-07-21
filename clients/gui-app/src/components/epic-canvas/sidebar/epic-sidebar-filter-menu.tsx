/**
 * Filter dropdowns rendered in the Agents and artifact panel headers.
 *
 * Agents: a single interface choice (All / Chat / Terminal). Every option lists
 * Agents; the axis narrows how they are interacted with, not what they are.
 * Artifact: multi-select status + kind, plus a read/unread choice.
 *
 * The trigger reflects active state so a filter that hides nodes is never
 * silent. Multi-select items keep the menu open on toggle.
 */
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ListFilter,
} from "lucide-react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ARTIFACT_SORT_FIELDS,
  CHAT_SORT_FIELDS,
  SORT_DIRECTION,
  SORT_FIELD_LABELS,
  type SortField,
  type SortMode,
} from "@/lib/epic-sort";
import {
  PANEL_HEADER_ACTION_REVEAL_CLASS,
  STATUS_DOT_CLASSES,
  STATUS_LABELS,
} from "./epic-sidebar-tree-shared";
import {
  ARTIFACT_READ,
  ARTIFACT_STATUS,
  artifactFilterCount,
  CHAT_ORIGIN,
  isArtifactFilterActive,
  isChatFilterActive,
  useArtifactFilter,
  useArtifactSort,
  useChatFilter,
  useChatSort,
  useLeftPanelStore,
  type ArtifactReadFilter,
  type ArtifactStatusFilter,
  type ChatOriginFilter,
} from "@/stores/epics/left-panel-store";

/**
 * The Agents panel filters on the INTERFACE axis - every option lists Agents,
 * narrowed by how the user interacts with them. `CHAT_ORIGIN.Gui` / `.Tui` are
 * internal filter values on the compatibility boundary; only the copy moves.
 */
const CHAT_ORIGIN_OPTIONS: ReadonlyArray<{
  value: ChatOriginFilter;
  label: string;
}> = [
  { value: CHAT_ORIGIN.All, label: "All" },
  { value: CHAT_ORIGIN.Gui, label: "Chat" },
  { value: CHAT_ORIGIN.Tui, label: "Terminal" },
];

const ARTIFACT_STATUS_OPTIONS: ReadonlyArray<ArtifactStatusFilter> = [
  ARTIFACT_STATUS.Todo,
  ARTIFACT_STATUS.InProgress,
  ARTIFACT_STATUS.Done,
];

const ARTIFACT_KIND_OPTIONS: ReadonlyArray<EpicArtifactKind> = [
  "spec",
  "ticket",
  "story",
  "review",
];

const ARTIFACT_READ_OPTIONS: ReadonlyArray<{
  value: ArtifactReadFilter;
  label: string;
}> = [
  { value: ARTIFACT_READ.All, label: "All" },
  { value: ARTIFACT_READ.Unread, label: "Unread" },
  { value: ARTIFACT_READ.Read, label: "Read" },
];

function FilterTrigger(props: {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly label: string;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={props.label}
        disabled={props.disabled}
        className={cn(
          "relative text-muted-foreground transition-opacity hover:text-foreground aria-expanded:opacity-100",
          props.active ? "text-foreground" : PANEL_HEADER_ACTION_REVEAL_CLASS,
        )}
      >
        <ListFilter className="size-4" />
        {props.active ? (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
        ) : null}
      </Button>
    </DropdownMenuTrigger>
  );
}

/**
 * Shared "Sort by" block for both panel filter dropdowns: a radio list of
 * the panel's allowed fields plus an ascending/descending toggle. The
 * toggle keeps the menu open (`onSelect` preventDefault) so direction and
 * field can be adjusted in one visit.
 */
function SortMenuSection(props: {
  fields: ReadonlyArray<SortField>;
  sort: SortMode;
  onFieldChange: (field: SortField) => void;
  onToggleDirection: () => void;
}) {
  const { fields, sort } = props;
  const isAscending = sort.direction === SORT_DIRECTION.Asc;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="px-2 py-1 text-overline uppercase text-muted-foreground/70">
        Sort by
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={sort.field}
        onValueChange={(next) => {
          const match = fields.find((field) => field === next);
          if (match !== undefined) props.onFieldChange(match);
        }}
      >
        {fields.map((field) => (
          <DropdownMenuRadioItem key={field} value={field}>
            {SORT_FIELD_LABELS[field]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(event) => {
          // Keep the menu open so field and direction can be tuned together.
          event.preventDefault();
          props.onToggleDirection();
        }}
      >
        {isAscending ? (
          <ArrowUpNarrowWide className="size-4" />
        ) : (
          <ArrowDownWideNarrow className="size-4" />
        )}
        {isAscending ? "Ascending" : "Descending"}
      </DropdownMenuItem>
    </>
  );
}

export function ChatFilterMenu(props: {
  readonly epicId: string;
  readonly disabled: boolean;
}) {
  const { epicId } = props;
  const filter = useChatFilter(epicId);
  const sort = useChatSort(epicId);
  const setChatOrigin = useLeftPanelStore((s) => s.setChatOrigin);
  const setChatSortField = useLeftPanelStore((s) => s.setChatSortField);
  const toggleChatSortDirection = useLeftPanelStore(
    (s) => s.toggleChatSortDirection,
  );
  const active = isChatFilterActive(filter);

  return (
    <DropdownMenu>
      <FilterTrigger
        active={active}
        disabled={props.disabled}
        label="Filter agents"
      />
      <DropdownMenuContent
        align="end"
        className="min-w-44 overflow-y-auto"
        style={{ maxHeight: "min(70vh, 24rem)" }}
      >
        <DropdownMenuLabel className="px-2 py-1 text-overline uppercase text-muted-foreground/70">
          Interface
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={filter.origin}
          onValueChange={(next) => {
            const match = CHAT_ORIGIN_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) setChatOrigin(epicId, match.value);
          }}
        >
          {CHAT_ORIGIN_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <SortMenuSection
          fields={CHAT_SORT_FIELDS}
          sort={sort}
          onFieldChange={(field) => setChatSortField(epicId, field)}
          onToggleDirection={() => toggleChatSortDirection(epicId)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactFilterMenu(props: {
  readonly epicId: string;
  readonly disabled: boolean;
}) {
  const { epicId } = props;
  const filter = useArtifactFilter(epicId);
  const sort = useArtifactSort(epicId);
  const toggleArtifactStatus = useLeftPanelStore((s) => s.toggleArtifactStatus);
  const toggleArtifactKind = useLeftPanelStore((s) => s.toggleArtifactKind);
  const setArtifactRead = useLeftPanelStore((s) => s.setArtifactRead);
  const clearArtifactFilter = useLeftPanelStore((s) => s.clearArtifactFilter);
  const setArtifactSortField = useLeftPanelStore((s) => s.setArtifactSortField);
  const toggleArtifactSortDirection = useLeftPanelStore(
    (s) => s.toggleArtifactSortDirection,
  );
  const active = isArtifactFilterActive(filter);
  const count = artifactFilterCount(filter);

  return (
    <DropdownMenu>
      <FilterTrigger
        active={active}
        disabled={props.disabled}
        label="Filter artifacts"
      />
      <DropdownMenuContent
        align="end"
        className="min-w-48 overflow-y-auto"
        style={{ maxHeight: "min(70vh, 24rem)" }}
      >
        <DropdownMenuLabel className="flex items-center justify-between px-2 py-1 text-overline uppercase text-muted-foreground/70">
          <span>Status</span>
          {active ? (
            <button
              type="button"
              className="text-ui-xs normal-case text-muted-foreground hover:text-foreground"
              onClick={() => clearArtifactFilter(epicId)}
            >
              Clear ({count})
            </button>
          ) : null}
        </DropdownMenuLabel>
        {ARTIFACT_STATUS_OPTIONS.map((status) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={filter.statuses.includes(status)}
            onCheckedChange={() => toggleArtifactStatus(epicId, status)}
            onSelect={(event) => event.preventDefault()}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                STATUS_DOT_CLASSES[status],
              )}
            />
            {STATUS_LABELS[status]}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1 text-overline uppercase text-muted-foreground/70">
          Type
        </DropdownMenuLabel>
        {ARTIFACT_KIND_OPTIONS.map((kind) => (
          <DropdownMenuCheckboxItem
            key={kind}
            checked={filter.kinds.includes(kind)}
            onCheckedChange={() => toggleArtifactKind(epicId, kind)}
            onSelect={(event) => event.preventDefault()}
          >
            {EPIC_NODE_LABELS[kind]}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1 text-overline uppercase text-muted-foreground/70">
          Read state
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter.read}
          onValueChange={(next) => {
            const match = ARTIFACT_READ_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) setArtifactRead(epicId, match.value);
          }}
        >
          {ARTIFACT_READ_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <SortMenuSection
          fields={ARTIFACT_SORT_FIELDS}
          sort={sort}
          onFieldChange={(field) => setArtifactSortField(epicId, field)}
          onToggleDirection={() => toggleArtifactSortDirection(epicId)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
