import {
  buildSubproviderEntries,
  type HarnessModelRow,
  type HarnessSubproviderEntry,
} from "@/components/home/data/harness-model-search";

export type CascadeLevel = "subproviders" | "models" | "efforts";

export interface CascadeState {
  readonly level: CascadeLevel;
  readonly activeGroupId: string | null;
  readonly pendingEffortModelId: string | null;
}

export const INITIAL_CASCADE_STATE: CascadeState = {
  level: "models",
  activeGroupId: null,
  pendingEffortModelId: null,
};

/**
 * Whether level 1 (subproviders) is shown for this provider's rows.
 * Skip when there are fewer than 2 distinct groups, or when the rail entry is
 * already profile-scoped (a specific credential of a multi-profile harness).
 */
export function shouldShowSubproviderLevel(
  entries: ReadonlyArray<HarnessSubproviderEntry>,
  profileScoped: boolean,
): boolean {
  if (profileScoped) return false;
  return entries.length >= 2;
}

/**
 * Resolves the cascade landing state when the picker opens or the rail switches
 * providers. Lands on the selected model's group (models level) when possible;
 * otherwise on subproviders when that level applies, else models.
 */
export function resolveCascadeForProvider(input: {
  readonly providerRows: ReadonlyArray<HarnessModelRow>;
  readonly selectedRowId: string;
  readonly profileScoped: boolean;
}): CascadeState {
  const { providerRows, selectedRowId, profileScoped } = input;
  const entries = buildSubproviderEntries(providerRows);
  const showSubproviders = shouldShowSubproviderLevel(entries, profileScoped);
  const selectedRow =
    selectedRowId.length === 0
      ? null
      : (providerRows.find((row) => row.id === selectedRowId) ?? null);

  if (
    showSubproviders &&
    selectedRow !== null &&
    selectedRow.providerGroupId !== null
  ) {
    return {
      level: "models",
      activeGroupId: selectedRow.providerGroupId,
      pendingEffortModelId: null,
    };
  }

  if (showSubproviders) {
    return {
      level: "subproviders",
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }

  return {
    level: "models",
    activeGroupId: null,
    pendingEffortModelId: null,
  };
}

export function cascadeSelectSubprovider(groupId: string): CascadeState {
  return {
    level: "models",
    activeGroupId: groupId,
    pendingEffortModelId: null,
  };
}

/**
 * Selecting a model: drill to efforts when the model advertises any, else complete.
 */
export function cascadeSelectModel(row: HarnessModelRow): {
  readonly kind: "complete";
} | {
  readonly kind: "drillEffort";
  readonly state: CascadeState;
} {
  if (row.model.supportedReasoningEfforts.length > 0) {
    return {
      kind: "drillEffort",
      state: {
        level: "efforts",
        activeGroupId: row.providerGroupId,
        pendingEffortModelId: row.id,
      },
    };
  }
  return { kind: "complete" };
}

/**
 * Navigate up one cascade level. Returns `null` when already at the root of
 * the current provider (caller should close the picker / leave rail focus).
 */
export function cascadeBack(
  state: CascadeState,
  canShowSubproviders: boolean,
): CascadeState | null {
  if (state.level === "efforts") {
    return {
      level: "models",
      activeGroupId: state.activeGroupId,
      pendingEffortModelId: null,
    };
  }
  if (state.level === "models" && canShowSubproviders) {
    return {
      level: "subproviders",
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }
  // Root: subproviders, or models with no subprovider level above.
  return null;
}

/** Path crumbs for the level-header back button (excludes the current level). */
export function cascadePathLabels(input: {
  readonly state: CascadeState;
  readonly providerLabel: string;
  readonly subproviderLabel: string | null;
  readonly pendingModelLabel: string | null;
}): ReadonlyArray<string> {
  const { state, providerLabel, subproviderLabel, pendingModelLabel } = input;
  if (state.level === "subproviders") return [];
  if (state.level === "models") {
    if (state.activeGroupId !== null && subproviderLabel !== null) {
      return [providerLabel, subproviderLabel];
    }
    return [];
  }
  // efforts
  const parts: string[] = [providerLabel];
  if (subproviderLabel !== null) parts.push(subproviderLabel);
  if (pendingModelLabel !== null) parts.push(pendingModelLabel);
  return parts;
}
