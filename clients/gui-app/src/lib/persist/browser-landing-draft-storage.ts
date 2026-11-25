import type { StateStorage } from "zustand/middleware";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { recordMapStorageKey } from "@/lib/persist/keys";
import { readLegacyDraftRecords } from "@/lib/drafts/draft-authority-legacy";

function decoded(raw: string | null): Record<string, unknown> | null {
  try {
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function scopedName(name: string): string {
  return `${name}:returned-drafts`;
}

function parentRows(state: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!isRecord(state) || !Array.isArray(state.drafts)) return result;
  for (const row of state.drafts) {
    if (isRecord(row) && typeof row.id === "string" && !result.has(row.id)) {
      result.set(row.id, row);
    }
  }
  return result;
}

export function readLegacyBrowserLandingDrafts(
  name: string,
): ReadonlyMap<string, Record<string, unknown> | null> {
  const result = new Map<string, Record<string, unknown> | null>(
    parentRows(decoded(localStorage.getItem(name))?.state),
  );
  for (const [id, row] of readLegacyDraftRecords(scopedName(name), "draftsById")) {
    if (row === null || row.id === id) result.set(id, row);
  }
  return result;
}

export function createBrowserLandingDraftStorage(): StateStorage<void> {
  return {
    getItem: (name) => {
      const legacy = decoded(localStorage.getItem(name));
      const state = isRecord(legacy?.state) ? legacy.state : {};
      const drafts = [...readLegacyBrowserLandingDrafts(name).values()].filter(
        (draft) => draft !== null,
      );
      if (legacy === null && drafts.length === 0) return null;
      return JSON.stringify({ ...legacy, state: { ...state, drafts } });
    },
    setItem: (name, value) => {
      const topology = decoded(value);
      if (!isRecord(topology?.state)) return;
      const previous = decoded(localStorage.getItem(name))?.state;
      // Keep legacy payloads available to the read-only importer.
      localStorage.setItem(
        name,
        JSON.stringify({
          ...topology,
          state: {
            activeDraftId: topology.state.activeDraftId,
            resumeDraftId: topology.state.resumeDraftId,
            drafts: isRecord(previous) ? previous.drafts : undefined,
          },
        }),
      );
    },
    removeItem: (name) => localStorage.removeItem(name),
  };
}

export function persistedBrowserLandingDraft(
  name: string,
  draftId: string,
  requireScoped: boolean,
): Record<string, unknown> | null {
  const scoped = localStorage.getItem(recordMapStorageKey(scopedName(name), draftId));
  if (scoped !== null || requireScoped) return decoded(scoped);
  return readLegacyBrowserLandingDrafts(name).get(draftId) ?? null;
}
