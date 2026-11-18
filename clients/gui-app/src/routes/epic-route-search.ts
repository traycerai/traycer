export interface EpicFocusSearch {
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly migrationSource: "phase" | undefined;
  readonly focusPaneId: string | undefined;
  readonly focusTileInstanceId: string | undefined;
}

export function normalizeEpicFocusSearch(
  search: Record<string, unknown>,
): EpicFocusSearch {
  return {
    focusedAt: normalizeFocusedAt(search.focusedAt),
    focusArtifactId: normalizeString(search.focusArtifactId),
    focusThreadId: normalizeString(search.focusThreadId),
    migrationSource: normalizeMigrationSource(search.migrationSource),
    focusPaneId: normalizeString(search.focusPaneId),
    focusTileInstanceId: normalizeString(search.focusTileInstanceId),
  };
}

function normalizeFocusedAt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const normalized = raw.trim();
    if (normalized.length === 0) return undefined;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMigrationSource(raw: unknown): "phase" | undefined {
  return raw === "phase" ? "phase" : undefined;
}
