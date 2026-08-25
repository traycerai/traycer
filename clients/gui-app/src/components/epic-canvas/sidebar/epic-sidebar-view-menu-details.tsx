/**
 * The view-menu bodies shared by the desktop sidebar and the mobile switcher.
 *
 * Each export here is a leaf: it renders `DropdownMenu*` items for one facet of
 * the view and takes that facet's value and setter as props, holding no state
 * and reading no view state of its own. That is the whole line between this
 * file and its callers -
 * the surrounding menu decides how the facets are REACHED (the sidebar nests
 * them behind submenus, or drills into them when a rail is too narrow for two
 * columns; the phone lists them one after another in a single scrolling menu),
 * while what each facet SAYS and DOES lives here once.
 *
 * A facet duplicated per surface is how two surfaces silently disagree about
 * the same persisted view state, so callers compose these rather than
 * re-declaring them.
 */
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  RotateCcw,
} from "lucide-react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  EPIC_NODE_ICONS,
  EPIC_NODE_LABELS,
} from "@/lib/artifacts/node-display";
import {
  ARTIFACT_SORT_FIELDS,
  CHAT_SORT_FIELDS,
  DEFAULT_SORT_MODE,
  SORT_DIRECTION,
  SORT_FIELD_LABELS,
  type SortField,
  type SortMode,
} from "@/lib/epic-sort";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  isSortModeActive,
  type ArtifactReadFilter,
  type ArtifactStatusFilter,
  type ChatArchiveVisibility,
  type ChatOriginFilter,
  type ChatOwnershipFilter,
} from "@/stores/epics/left-panel-store";
import { STATUS_DOT_CLASSES, STATUS_LABELS } from "./epic-sidebar-tree-shared";
import {
  ARTIFACT_KIND_OPTIONS,
  ARTIFACT_READ_OPTIONS,
  ARTIFACT_STATUS_OPTIONS,
  CHAT_ARCHIVE_VISIBILITY_OPTIONS,
  CHAT_ORIGIN_OPTIONS,
  CHAT_OWNERSHIP_OPTIONS,
  type ArtifactViewDetail,
  type ChatViewDetail,
} from "./epic-sidebar-view-menu-shared";

/**
 * Field and direction pickers for a panel's sort mode, plus a reset that only
 * appears once the mode is off its default.
 *
 * Every item preventDefaults its own select so the menu stays open: ordering is
 * a control the user re-aims (pick a field, then flip the direction), and a
 * menu that closed on the first pick would have to be reopened to finish the
 * thought.
 */
export function OrderingDetail(props: {
  readonly fields: ReadonlyArray<SortField>;
  readonly sort: SortMode;
  readonly onFieldChange: (field: SortField) => void;
  readonly onToggleDirection: () => void;
}) {
  const resetOrdering = (): void => {
    props.onFieldChange(DEFAULT_SORT_MODE.field);
    if (props.sort.direction !== DEFAULT_SORT_MODE.direction) {
      props.onToggleDirection();
    }
  };
  return (
    <>
      <DropdownMenuLabel>Order by</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={props.sort.field}
        onValueChange={(next) => {
          const match = props.fields.find((field) => field === next);
          if (match !== undefined) props.onFieldChange(match);
        }}
      >
        {props.fields.map((field) => (
          <DropdownMenuRadioItem
            key={field}
            value={field}
            onSelect={(event) => event.preventDefault()}
          >
            {SORT_FIELD_LABELS[field]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup value={props.sort.direction}>
        <DropdownMenuRadioItem
          value={SORT_DIRECTION.Desc}
          onSelect={(event) => {
            event.preventDefault();
            if (props.sort.direction !== SORT_DIRECTION.Desc) {
              props.onToggleDirection();
            }
          }}
        >
          <ArrowDownWideNarrow className="size-4" />
          Descending
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value={SORT_DIRECTION.Asc}
          onSelect={(event) => {
            event.preventDefault();
            if (props.sort.direction !== SORT_DIRECTION.Asc) {
              props.onToggleDirection();
            }
          }}
        >
          <ArrowUpNarrowWide className="size-4" />
          Ascending
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {isSortModeActive(props.sort) ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              resetOrdering();
            }}
          >
            <RotateCcw className="size-4" />
            Reset ordering
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * The "how many filters are on" count that rides the corner of a view-menu
 * trigger, capped at `9+` so a wide count cannot stretch the icon button.
 *
 * `aria-hidden`: the trigger's own label already spells the count out, and a
 * screen reader reading a bare digit beside it would say the number twice.
 * Renders nothing at zero, so an unfiltered trigger is a plain icon.
 */
export function ViewMenuBadge(props: { readonly filterCount: number }) {
  if (props.filterCount <= 0) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background ring-1 ring-background"
    >
      {props.filterCount > 9 ? "9+" : String(props.filterCount)}
    </span>
  );
}

/** Archive visibility: which of unarchived / archived / all chats to render. */
export function ChatShowDetail(props: {
  readonly archiveVisibility: ChatArchiveVisibility;
  readonly setArchiveVisibility: (visibility: ChatArchiveVisibility) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={props.archiveVisibility}
      onValueChange={(next) => {
        const match = CHAT_ARCHIVE_VISIBILITY_OPTIONS.find(
          (option) => option.value === next,
        );
        if (match !== undefined) {
          props.setArchiveVisibility(match.value);
        }
      }}
      data-testid="epic-sidebar-archive-visibility"
    >
      {CHAT_ARCHIVE_VISIBILITY_OPTIONS.map((option) => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          onSelect={(event) => event.preventDefault()}
          data-testid={`epic-sidebar-archive-visibility-${option.value}`}
        >
          {option.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** Interface facet: all agents, GUI chats only, or terminal agents only. */
export function ChatInterfaceDetail(props: {
  readonly filterOrigin: ChatOriginFilter;
  readonly setChatOrigin: (origin: ChatOriginFilter) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={props.filterOrigin}
      onValueChange={(next) => {
        const match = CHAT_ORIGIN_OPTIONS.find(
          (option) => option.value === next,
        );
        if (match !== undefined) props.setChatOrigin(match.value);
      }}
    >
      {CHAT_ORIGIN_OPTIONS.map((option) => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          onSelect={(event) => event.preventDefault()}
        >
          {option.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** Ownership facet: everyone's agents, the viewer's own, or other people's. */
export function ChatOwnershipDetail(props: {
  readonly filterOwnership: ChatOwnershipFilter;
  readonly setChatOwnership: (ownership: ChatOwnershipFilter) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={props.filterOwnership}
      onValueChange={(next) => {
        const match = CHAT_OWNERSHIP_OPTIONS.find(
          (option) => option.value === next,
        );
        if (match !== undefined) props.setChatOwnership(match.value);
      }}
    >
      {CHAT_OWNERSHIP_OPTIONS.map((option) => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          onSelect={(event) => event.preventDefault()}
        >
          {option.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/**
 * The Agents facets behind one `detail` key, for a menu that shows exactly one
 * at a time and would otherwise carry the switch itself. A caller that renders
 * several facets composes the leaves above instead, so it passes only the props
 * the facets it shows actually use.
 */
export function ChatDetailContent(props: {
  readonly detail: ChatViewDetail;
  readonly filterOrigin: ChatOriginFilter;
  readonly filterOwnership: ChatOwnershipFilter;
  readonly sort: SortMode;
  readonly archiveVisibility: ChatArchiveVisibility;
  readonly setChatOrigin: (origin: ChatOriginFilter) => void;
  readonly setChatOwnership: (ownership: ChatOwnershipFilter) => void;
  readonly setArchiveVisibility: (visibility: ChatArchiveVisibility) => void;
  readonly setSortField: (field: SortField) => void;
  readonly toggleSortDirection: () => void;
}) {
  switch (props.detail) {
    case "ordering":
      return (
        <OrderingDetail
          fields={CHAT_SORT_FIELDS}
          sort={props.sort}
          onFieldChange={props.setSortField}
          onToggleDirection={props.toggleSortDirection}
        />
      );
    case "show":
      return (
        <ChatShowDetail
          archiveVisibility={props.archiveVisibility}
          setArchiveVisibility={props.setArchiveVisibility}
        />
      );
    case "interface":
      return (
        <ChatInterfaceDetail
          filterOrigin={props.filterOrigin}
          setChatOrigin={props.setChatOrigin}
        />
      );
    case "ownership":
      return (
        <ChatOwnershipDetail
          filterOwnership={props.filterOwnership}
          setChatOwnership={props.setChatOwnership}
        />
      );
  }
}

/** One Artifacts facet, chosen by `detail`. Mirrors {@link ChatDetailContent}. */
export function ArtifactDetailContent(props: {
  readonly detail: ArtifactViewDetail;
  readonly filterStatuses: readonly ArtifactStatusFilter[];
  readonly filterKinds: readonly EpicArtifactKind[];
  readonly filterRead: ArtifactReadFilter;
  readonly sort: SortMode;
  readonly toggleStatus: (status: ArtifactStatusFilter) => void;
  readonly toggleKind: (kind: EpicArtifactKind) => void;
  readonly setRead: (read: ArtifactReadFilter) => void;
  readonly setSortField: (field: SortField) => void;
  readonly toggleSortDirection: () => void;
}) {
  switch (props.detail) {
    case "ordering":
      return (
        <OrderingDetail
          fields={ARTIFACT_SORT_FIELDS}
          sort={props.sort}
          onFieldChange={props.setSortField}
          onToggleDirection={props.toggleSortDirection}
        />
      );
    case "status":
      return (
        <>
          {ARTIFACT_STATUS_OPTIONS.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={props.filterStatuses.includes(status)}
              onCheckedChange={() => props.toggleStatus(status)}
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
        </>
      );
    case "type":
      return (
        <ArtifactTypeDetail
          filterKinds={props.filterKinds}
          toggleKind={props.toggleKind}
        />
      );
    case "read":
      return (
        <DropdownMenuRadioGroup
          value={props.filterRead}
          onValueChange={(next) => {
            const match = ARTIFACT_READ_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) props.setRead(match.value);
          }}
        >
          {ARTIFACT_READ_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={(event) => event.preventDefault()}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );
  }
}

/**
 * Kind checkboxes, each carrying the icon the artifact's rows carry - including
 * the user's per-type icon colour, so the menu entry and the row it filters for
 * are recognizably the same thing.
 */
function ArtifactTypeDetail(props: {
  readonly filterKinds: readonly EpicArtifactKind[];
  readonly toggleKind: (kind: EpicArtifactKind) => void;
}) {
  const artifactIconColors = useSettingsStore(
    (state) => state.artifactIconColors,
  );
  const artifactIconColorMode = useSettingsStore(
    (state) => state.artifactIconColorMode,
  );

  return ARTIFACT_KIND_OPTIONS.map((kind) => {
    const TypeIcon = EPIC_NODE_ICONS[kind];
    const iconStyle =
      artifactIconColorMode === "byType"
        ? { color: artifactIconColors[kind] }
        : undefined;
    return (
      <DropdownMenuCheckboxItem
        key={kind}
        checked={props.filterKinds.includes(kind)}
        onCheckedChange={() => props.toggleKind(kind)}
        onSelect={(event) => event.preventDefault()}
      >
        <TypeIcon
          className={cn(
            "size-3.5",
            artifactIconColorMode === "none" && "text-muted-foreground",
          )}
          style={iconStyle}
        />
        {EPIC_NODE_LABELS[kind]}
      </DropdownMenuCheckboxItem>
    );
  });
}
