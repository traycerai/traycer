import {
  findStripItemForRef,
  type PersistedTabStripLayout,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import { tabSurfaceDescriptor } from "@/stores/tabs/registry";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { isTabStructurallyLocked } from "@/stores/tabs/tab-structural-lock";
import { useTabsStore } from "@/stores/tabs/store";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";

export type FillableSlotDestination =
  | { readonly kind: "open-ref"; readonly ref: TabRef }
  | { readonly kind: "system"; readonly systemKind: "history" | "settings" }
  | {
      readonly kind: "epic";
      readonly epicId: string;
      readonly name: string | undefined;
    }
  | { readonly kind: "new-draft" }
  | {
      readonly kind: "phase-migration";
      readonly phaseId: string;
      readonly name: string | undefined;
    };

export interface FillableSlotChoice {
  readonly id: string;
  readonly label: string;
  readonly destination: FillableSlotDestination;
  readonly group: "open" | "destination";
}

export type FillableSlotCatalogEntry =
  | {
      readonly kind: "epic";
      readonly epicId: string;
      readonly name: string | undefined;
    }
  | {
      readonly kind: "phase-migration";
      readonly phaseId: string;
      readonly name: string | undefined;
    };

export type FillableSlotResolution =
  | { readonly kind: "fill"; readonly ref: TabRef }
  | {
      readonly kind: "create-system";
      readonly systemKind: "history" | "settings";
    }
  | {
      readonly kind: "create-epic";
      readonly epicId: string;
      readonly name: string | undefined;
    }
  | { readonly kind: "create-draft" }
  | {
      readonly kind: "create-phase-migration";
      readonly phaseId: string;
      readonly name: string | undefined;
    }
  | { readonly kind: "activate-existing"; readonly ref: TabRef }
  | { readonly kind: "invalid" };

export function getFillableSlotChoices(
  splitId: string,
  side: SplitSideName,
): ReadonlyArray<FillableSlotChoice> {
  const state = useTabsStore.getState();
  const split = findSplit(state.items, splitId);
  const target = split === null ? null : splitSide(split, side);
  if (target === null || target.kind === "tab") return [];
  const open = getHeaderTabs().flatMap((tab) => {
    const ref = refForTab(tab);
    const item = findStripItemForRef(layoutFromState(), ref);
    return item?.kind === "tab" && canFillWith(ref)
      ? [
          {
            id: `open:${ref.kind}:${ref.id}`,
            label: tab.name,
            destination: { kind: "open-ref" as const, ref },
            group: "open" as const,
          },
        ]
      : [];
  });
  return [
    ...open,
    {
      id: "destination:history",
      label: "History",
      destination: { kind: "system", systemKind: "history" },
      group: "destination",
    },
    {
      id: "destination:settings",
      label: "Settings",
      destination: { kind: "system", systemKind: "settings" },
      group: "destination",
    },
    {
      id: "destination:new-draft",
      label: "New Task",
      destination: { kind: "new-draft" },
      group: "destination",
    },
  ];
}

/** Adds descriptor-approved History catalog rows after reusable open refs. */
export function getFillableSlotChoicesWithCatalog(
  splitId: string,
  side: SplitSideName,
  catalog: ReadonlyArray<FillableSlotCatalogEntry>,
): ReadonlyArray<FillableSlotChoice> {
  const choices = getFillableSlotChoices(splitId, side);
  const existingIds = new Set(choices.map((choice) => choice.id));
  // An Epic reachable both as an open ref (row id keyed by tab id) and a
  // catalog destination (row id keyed by Epic id) never collides on id
  // string alone - dedupe by the Epic's identity instead.
  const openEpicIds = new Set(
    getHeaderTabs().flatMap((tab) =>
      tab.kind === "epic" && existingIds.has(`open:epic:${tab.id}`)
        ? [tab.epicId]
        : [],
    ),
  );
  const allCatalog = [...sameEpicCatalog(splitId, side), ...catalog];
  const catalogChoices = allCatalog.flatMap(
    (entry): ReadonlyArray<FillableSlotChoice> => {
      const id =
        entry.kind === "epic"
          ? `destination:epic:${entry.epicId}`
          : `destination:phase:${entry.phaseId}`;
      if (existingIds.has(id)) return [];
      if (entry.kind === "epic" && openEpicIds.has(entry.epicId)) return [];
      if (entry.kind === "phase-migration") {
        const migration = findPhaseMigrationRef(entry.phaseId);
        if (migration !== null && isTabStructurallyLocked(migration)) {
          return [];
        }
      }
      existingIds.add(id);
      return [
        {
          id,
          label:
            entry.name ??
            (entry.kind === "epic" ? "Untitled epic" : "Legacy Phase"),
          destination:
            entry.kind === "epic"
              ? {
                  kind: "epic",
                  epicId: entry.epicId,
                  name: entry.name,
                }
              : {
                  kind: "phase-migration",
                  phaseId: entry.phaseId,
                  name: entry.name,
                },
          group: "destination",
        },
      ];
    },
  );
  const open = choices.filter((choice) => choice.group === "open");
  const history = choices.find((choice) => choice.id === "destination:history");
  const settings = choices.find(
    (choice) => choice.id === "destination:settings",
  );
  const newDraft = choices.find(
    (choice) => choice.id === "destination:new-draft",
  );
  const epics = catalogChoices.filter(
    (choice) => choice.destination.kind === "epic",
  );
  const phases = catalogChoices.filter(
    (choice) => choice.destination.kind === "phase-migration",
  );
  return [
    ...open,
    ...optionalChoice(history),
    ...optionalChoice(settings),
    ...epics,
    ...optionalChoice(newDraft),
    ...phases,
  ];
}

function sameEpicCatalog(
  splitId: string,
  side: SplitSideName,
): ReadonlyArray<FillableSlotCatalogEntry> {
  const split = findSplit(useTabsStore.getState().items, splitId);
  if (split === null) return [];
  const partner = side === "left" ? split.right : split.left;
  if (partner.kind !== "tab" || partner.ref.kind !== "epic") return [];
  // A Phase-migration tab reuses `epicId` as a placeholder for its phaseId
  // (see openEpicTabWithId's phase-migration branch) - surfacing it here
  // would offer a bogus "Epic" destination whose id is actually the Phase's
  // tab id, bypassing the dedicated phase-migration catalog entry kind.
  const canvasTab = useEpicCanvasStore.getState().tabsById[partner.ref.id];
  if (canvasTab?.surfaceMode?.kind === "phase-migration") return [];
  const tab = getHeaderTabs().find(
    (candidate) => candidate.kind === "epic" && candidate.id === partner.ref.id,
  );
  return tab?.kind === "epic"
    ? [{ kind: "epic", epicId: tab.epicId, name: tab.name }]
    : [];
}

function optionalChoice(
  choice: FillableSlotChoice | undefined,
): ReadonlyArray<FillableSlotChoice> {
  return choice === undefined ? [] : [choice];
}

/**
 * Resolve first, then mutate once. Singleton selections already represented
 * by another split intentionally activate that group and leave this fillable
 * side untouched; duplicate-able Epics always get a distinct ref when no
 * ungrouped reusable view is available.
 */
export function resolveFillableSlotDestination(
  splitId: string,
  side: SplitSideName,
  destination: FillableSlotDestination,
): FillableSlotResolution {
  const layout = layoutFromState();
  const split = findSplit(layout.items, splitId);
  if (split === null || splitSide(split, side).kind === "tab") {
    return { kind: "invalid" };
  }
  if (destination.kind === "open-ref") {
    return resolveExistingRef(layout, destination.ref);
  }
  if (destination.kind === "new-draft") return { kind: "create-draft" };
  if (destination.kind === "system") {
    const ref: TabRef = {
      kind: destination.systemKind,
      id: destination.systemKind,
    };
    const existing = findStripItemForRef(layout, ref);
    if (existing === null) {
      return { kind: "create-system", systemKind: destination.systemKind };
    }
    return existing.kind === "split"
      ? { kind: "activate-existing", ref }
      : { kind: "fill", ref };
  }
  if (destination.kind === "phase-migration") {
    const migration = findPhaseMigrationRef(destination.phaseId);
    if (migration === null) {
      return {
        kind: "create-phase-migration",
        phaseId: destination.phaseId,
        name: destination.name,
      };
    }
    return resolveExistingRef(layout, migration);
  }
  const reusable = findUngroupedEpicRef(layout, destination.epicId);
  if (reusable !== null) {
    return { kind: "fill", ref: reusable };
  }
  return {
    kind: "create-epic",
    epicId: destination.epicId,
    name: destination.name,
  };
}

export function commitFillableSlotDestination(input: {
  readonly splitId: string;
  readonly side: SplitSideName;
  readonly destination: FillableSlotDestination;
  /** Caller routes this through activateTabIntent only for focused fills. */
  readonly activateFocusedRef: (ref: TabRef) => void;
}): FillableSlotResolution {
  const resolution = resolveFillableSlotDestination(
    input.splitId,
    input.side,
    input.destination,
  );
  if (resolution.kind === "invalid") return resolution;
  if (resolution.kind === "activate-existing") {
    input.activateFocusedRef(resolution.ref);
    return resolution;
  }
  const focused = splitIsFocused(input.splitId, input.side);
  const ref = commitFillResolution(input, resolution);
  if (ref !== null && focused) input.activateFocusedRef(ref);
  return resolution;
}

function commitFillResolution(
  input: {
    readonly splitId: string;
    readonly side: SplitSideName;
  },
  resolution: Exclude<
    FillableSlotResolution,
    { readonly kind: "invalid" | "activate-existing" }
  >,
): TabRef | null {
  if (resolution.kind === "fill") {
    return tabCommandCoordinator.fillSplitSide({
      splitId: input.splitId,
      side: input.side,
      ref: resolution.ref,
    })
      ? resolution.ref
      : null;
  }
  if (resolution.kind === "create-draft") {
    return tabCommandCoordinator.createDraftForSplit(input);
  }
  if (resolution.kind === "create-system") {
    return tabCommandCoordinator.createSystemForSplit({
      ...input,
      systemKind: resolution.systemKind,
      name: resolution.systemKind === "history" ? "History" : "Settings",
      lastPath:
        resolution.systemKind === "history" ? "/epics" : "/settings/general",
    });
  }
  if (resolution.kind === "create-epic") {
    return tabCommandCoordinator.createEpicForSplit({
      ...input,
      epicId: resolution.epicId,
      name: resolution.name,
    });
  }
  return tabCommandCoordinator.createPhaseMigrationForSplit({
    ...input,
    phaseId: resolution.phaseId,
    name: resolution.name,
  });
}

function resolveExistingRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): FillableSlotResolution {
  const item = findStripItemForRef(layout, ref);
  if (item === null) return { kind: "invalid" };
  return item.kind === "split"
    ? { kind: "activate-existing", ref }
    : { kind: "fill", ref };
}

function layoutFromState(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2 as const,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

function findSplit(
  items: ReadonlyArray<StripItem>,
  splitId: string,
): SplitStripItem | null {
  return (
    items.find(
      (item): item is SplitStripItem =>
        item.kind === "split" && item.id === splitId,
    ) ?? null
  );
}

function splitSide(split: SplitStripItem, side: SplitSideName) {
  return side === "left" ? split.left : split.right;
}

function splitIsFocused(splitId: string, side: SplitSideName): boolean {
  const state = useTabsStore.getState();
  const split = findSplit(state.items, splitId);
  return split?.focusedSide === side;
}

function refForTab(tab: HeaderTab): TabRef {
  return { kind: tab.kind, id: tab.id };
}

function canFillWith(ref: TabRef): boolean {
  return (
    !isTabStructurallyLocked(ref) &&
    tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible"
  );
}

function findUngroupedEpicRef(
  layout: PersistedTabStripLayout,
  epicId: string,
): TabRef | null {
  const tab = getHeaderTabs().find(
    (candidate) =>
      candidate.kind === "epic" &&
      candidate.epicId === epicId &&
      findStripItemForRef(layout, refForTab(candidate))?.kind === "tab",
  );
  return tab === undefined ? null : refForTab(tab);
}

function findPhaseMigrationRef(phaseId: string): TabRef | null {
  // Runtime migration metadata lives in the Epic source store. Keeping this
  // lookup lazy avoids making the persisted layout invent a second phase kind.
  const matching = Object.values(useEpicCanvasStore.getState().tabsById).find(
    (tab) => {
      if (tab === undefined) return false;
      if (tab.surfaceMode?.kind !== "phase-migration") return false;
      return tab.surfaceMode.phaseId === phaseId;
    },
  );
  return matching === undefined ? null : { kind: "epic", id: matching.tabId };
}
