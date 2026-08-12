import {
  buildSourceEntries,
  buildSubproviderEntries,
  type HarnessModelRow,
  type HarnessSourceEntry,
  type HarnessSubproviderEntry,
} from "@/components/home/data/harness-model-search";

export type CascadeLevel = "sources" | "subproviders" | "models" | "efforts";

export interface CascadeState {
  readonly level: CascadeLevel;
  readonly activeSourceId: string | null;
  readonly activeGroupId: string | null;
  readonly pendingEffortModelId: string | null;
}

export const INITIAL_CASCADE_STATE: CascadeState = {
  level: "models",
  activeSourceId: null,
  activeGroupId: null,
  pendingEffortModelId: null,
};

export interface CascadeBackFlags {
  readonly canShowSources: boolean;
  readonly canShowSubproviders: boolean;
}

/**
 * Whether the source (gateway) level is shown. Only composite `source:vendor`
 * catalogs (Hermes/OMP `openrouter:anthropic`) introduce this step. Skip when
 * the rail entry is already profile-scoped.
 */
export function shouldShowSourceLevel(
  entries: ReadonlyArray<HarnessSourceEntry>,
  profileScoped: boolean,
): boolean {
  if (profileScoped) return false;
  if (entries.length === 0) return false;
  if (entries.length >= 2) return true;
  const only = entries[0];
  return only !== undefined && only.nested && only.vendorCount >= 2;
}

/**
 * Whether the vendor (subprovider) level is shown for this provider's rows.
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
 * otherwise on sources / subproviders when those levels apply, else models.
 */
export function resolveCascadeForProvider(input: {
  readonly providerRows: ReadonlyArray<HarnessModelRow>;
  readonly selectedRowId: string;
  readonly profileScoped: boolean;
}): CascadeState {
  const { providerRows, selectedRowId, profileScoped } = input;
  const sourceEntries = buildSourceEntries(providerRows);
  const showSources = shouldShowSourceLevel(sourceEntries, profileScoped);
  const selectedRow =
    selectedRowId.length === 0
      ? null
      : (providerRows.find((row) => row.id === selectedRowId) ?? null);
  const selectedSourceId = selectedRow?.sourceGroupId ?? null;
  const vendorEntries = buildSubproviderEntries(
    providerRows,
    showSources ? selectedSourceId : null,
  );
  const showSubproviders = shouldShowSubproviderLevel(
    vendorEntries,
    profileScoped,
  );

  if (
    showSources &&
    selectedRow !== null &&
    selectedSourceId !== null &&
    selectedRow.providerGroupId !== null
  ) {
    return {
      level: "models",
      activeSourceId: selectedSourceId,
      activeGroupId: selectedRow.providerGroupId,
      pendingEffortModelId: null,
    };
  }

  if (
    showSubproviders &&
    selectedRow !== null &&
    selectedRow.providerGroupId !== null
  ) {
    return {
      level: "models",
      activeSourceId: selectedSourceId,
      activeGroupId: selectedRow.providerGroupId,
      pendingEffortModelId: null,
    };
  }

  if (showSources) {
    return {
      level: "sources",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }

  if (showSubproviders) {
    return {
      level: "subproviders",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }

  return {
    level: "models",
    activeSourceId: null,
    activeGroupId: null,
    pendingEffortModelId: null,
  };
}

export function cascadeSelectSource(
  sourceId: string,
  vendorEntries: ReadonlyArray<HarnessSubproviderEntry>,
): CascadeState {
  if (shouldShowSubproviderLevel(vendorEntries, false)) {
    return {
      level: "subproviders",
      activeSourceId: sourceId,
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }
  const only = vendorEntries.at(0);
  return {
    level: "models",
    activeSourceId: sourceId,
    activeGroupId: only?.providerGroupId ?? null,
    pendingEffortModelId: null,
  };
}

export function cascadeSelectSubprovider(
  groupId: string,
  sourceId: string | null,
): CascadeState {
  return {
    level: "models",
    activeSourceId: sourceId,
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
        activeSourceId: row.sourceGroupId,
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
  flags: CascadeBackFlags,
): CascadeState | null {
  if (state.level === "efforts") {
    return {
      level: "models",
      activeSourceId: state.activeSourceId,
      activeGroupId: state.activeGroupId,
      pendingEffortModelId: null,
    };
  }
  if (state.level === "models" && flags.canShowSubproviders) {
    return {
      level: "subproviders",
      activeSourceId: state.activeSourceId,
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }
  if (
    (state.level === "models" || state.level === "subproviders") &&
    flags.canShowSources
  ) {
    return {
      level: "sources",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    };
  }
  return null;
}

/** Path crumbs for the level-header back button (excludes the current level). */
export function cascadePathLabels(input: {
  readonly state: CascadeState;
  readonly providerLabel: string;
  readonly sourceLabel: string | null;
  readonly subproviderLabel: string | null;
  readonly pendingModelLabel: string | null;
}): ReadonlyArray<string> {
  const {
    state,
    providerLabel,
    sourceLabel,
    subproviderLabel,
    pendingModelLabel,
  } = input;
  if (state.level === "sources") return [];
  if (state.level === "subproviders") {
    return sourceLabel === null ? [] : [providerLabel, sourceLabel];
  }
  if (state.level === "models") {
    const parts: string[] = [];
    if (state.activeSourceId !== null && sourceLabel !== null) {
      parts.push(providerLabel, sourceLabel);
    }
    if (state.activeGroupId !== null && subproviderLabel !== null) {
      if (parts.length === 0) parts.push(providerLabel);
      parts.push(subproviderLabel);
    }
    return parts;
  }
  const parts: string[] = [providerLabel];
  if (sourceLabel !== null) parts.push(sourceLabel);
  if (subproviderLabel !== null) parts.push(subproviderLabel);
  if (pendingModelLabel !== null) parts.push(pendingModelLabel);
  return parts;
}
