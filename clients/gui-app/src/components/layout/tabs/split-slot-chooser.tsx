import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  commitFillableSlotDestination,
  getFillableSlotChoicesWithCatalog,
  type FillableSlotCatalogEntry,
} from "@/components/layout/tabs/fillable-slot";
import { cn } from "@/lib/utils";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { tabResolveIntent } from "@/stores/tabs/registry";
import { useTabsStore } from "@/stores/tabs/store";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import type { SplitSide, SplitSideName } from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { useHostBinding } from "@/lib/host";
import {
  getTabStructuralLockRevision,
  subscribeTabStructuralLocks,
} from "@/stores/tabs/tab-structural-lock";

export interface SplitSlotChooserProps {
  readonly splitId: string;
  readonly side: SplitSideName;
  readonly slot: Exclude<SplitSide, { readonly kind: "tab" }>;
  readonly focused: boolean;
}

export function SplitSlotChooser(props: SplitSlotChooserProps) {
  const [query, setQuery] = useState("");
  const binding = useHostBinding();
  if (binding === null) {
    return (
      <SplitSlotChooserContent
        {...props}
        catalog={EMPTY_CATALOG}
        query={query}
        onQueryChange={setQuery}
      />
    );
  }
  return (
    <CataloguedSplitSlotChooser
      {...props}
      query={query}
      onQueryChange={setQuery}
    />
  );
}

const EMPTY_CATALOG: ReadonlyArray<FillableSlotCatalogEntry> = [];

function CataloguedSplitSlotChooser(
  props: SplitSlotChooserProps & {
    readonly query: string;
    readonly onQueryChange: (query: string) => void;
  },
) {
  const history = useHistoryQuery({
    search: { ...DEFAULT_HISTORY_SEARCH, query: props.query },
    nowMs: null,
  });
  const catalog = useMemo<ReadonlyArray<FillableSlotCatalogEntry>>(
    () =>
      (history.data?.items ?? []).map((item) =>
        item.taskType === "epic"
          ? { kind: "epic", epicId: item.epicId, name: item.title }
          : {
              kind: "phase-migration",
              phaseId: item.epicId,
              name: item.title,
            },
      ),
    [history.data],
  );
  return <SplitSlotChooserContent {...props} catalog={catalog} />;
}

export function SplitSlotChooserContent(
  props: SplitSlotChooserProps & {
    readonly catalog: ReadonlyArray<FillableSlotCatalogEntry>;
    readonly query: string;
    readonly onQueryChange: (query: string) => void;
  },
) {
  const navigate = useNavigate();
  useTabsStore((state) => state.items);
  useSyncExternalStore(
    subscribeTabStructuralLocks,
    getTabStructuralLockRevision,
    getTabStructuralLockRevision,
  );
  const searchRef = useRef<HTMLInputElement | null>(null);
  const choices = getFillableSlotChoicesWithCatalog(
    props.splitId,
    props.side,
    props.catalog,
  );
  const filtered = useMemo(
    () =>
      choices.filter((choice) =>
        choice.label
          .toLocaleLowerCase()
          .includes(props.query.toLocaleLowerCase()),
      ),
    [choices, props.query],
  );
  const activateFocusedRef = useCallback(
    (ref: TabRef): void => {
      const tab = getHeaderTabs().find(
        (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
      );
      if (tab !== undefined) {
        navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
      }
    },
    [navigate],
  );
  useEffect(() => {
    if (!props.focused) return;
    searchRef.current?.focus();
  }, [props.focused]);

  return (
    <section
      aria-label={`${props.slot.kind === "unavailable" ? "Unavailable" : "Empty"} split view`}
      className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-3 border border-dashed border-border/80 bg-muted/20 p-[clamp(0.75rem,3vw,2rem)]"
      data-testid={`split-slot-chooser-${props.side}`}
    >
      <div className="max-w-prose text-center">
        <p className="text-ui-sm font-medium text-foreground">
          {props.slot.kind === "unavailable"
            ? props.slot.label
            : "Choose a view for this split"}
        </p>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          Search open tabs or choose a destination. You can also drop an
          unpaired tab here.
        </p>
      </div>
      <input
        ref={searchRef}
        aria-label="Search tabs and destinations"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        placeholder="Search views"
        className="w-full max-w-[min(92vw,28rem)] rounded-md border border-input bg-background px-3 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex w-full max-w-[min(92vw,28rem)] flex-col gap-1 overflow-y-auto">
        {filtered.map((choice) => (
          <Button
            key={choice.id}
            type="button"
            variant="ghost"
            className={cn(
              "justify-start",
              choice.group === "destination" && "text-muted-foreground",
            )}
            onClick={() =>
              commitFillableSlotDestination({
                splitId: props.splitId,
                side: props.side,
                destination: choice.destination,
                activateFocusedRef,
              })
            }
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
