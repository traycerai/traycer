import type { StateStorage } from "zustand/middleware";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { recordMapStorageKey } from "@/lib/persist/keys";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";
import {
  parseReturnedSandbox,
  reconcileReturnedDraftFields,
} from "@/lib/sandboxes/returned-sandbox";

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function decoded(raw: string | null): Record<string, unknown> | null {
  try {
    return raw === null ? null : record(JSON.parse(raw));
  } catch {
    return null;
  }
}

function scopedName(name: string): string {
  return `${name}:returned-drafts`;
}

function scopedKey(name: string, draftId: string): string {
  return recordMapStorageKey(scopedName(name), draftId);
}

function rows(
  state: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(state.drafts)) return result;
  for (const raw of state.drafts) {
    const row = record(raw);
    if (typeof row?.id === "string" && !result.has(row.id))
      result.set(row.id, row);
  }
  return result;
}

function reconcileScopedRow(
  observed: string | undefined,
  durable: string,
  proposed: string,
): string | undefined {
  const before = decoded(observed ?? null);
  const saved = decoded(durable);
  if (before === null || saved === null) return undefined;
  const next = decoded(proposed);
  if (next === null && proposed !== "null") return undefined;
  return JSON.stringify(reconcileReturnedDraftFields(before, saved, next));
}

/** Only browser drafts with returned destinations need an independent durable row. */
export function createBrowserLandingDraftStorage(): StateStorage<void> {
  const scoped = createRecordMapStorage({
    field: "draftsById",
    reconcile: reconcileScopedRow,
  });
  return {
    getItem: (name) => {
      const legacy = decoded(localStorage.getItem(name));
      const state = record(legacy?.state) ?? {};
      const saved = decoded(scoped.getItem(scopedName(name)));
      const byId = record(record(saved?.state)?.draftsById);
      const restored = rows(state);
      for (const [id, raw] of Object.entries(byId ?? {})) {
        const row = record(raw);
        if (row?.id === id) restored.set(id, row);
      }
      if (legacy === null && restored.size === 0) return null;
      return JSON.stringify({
        ...legacy,
        version: legacy?.version ?? saved?.version,
        state: { ...state, drafts: [...restored.values()] },
      });
    },
    setItem: (name, value) => {
      const snapshot = decoded(value);
      const draftsById = Object.fromEntries(
        [...rows(record(snapshot?.state) ?? {})].filter(([id, draft]) => {
          const saved = localStorage.getItem(scopedKey(name, id));
          return (
            (saved !== null && saved !== "null") ||
            parseReturnedSandbox(draft.returnedSandbox) !== null
          );
        }),
      );
      scoped.setItem(
        scopedName(name),
        JSON.stringify({ version: snapshot?.version, state: { draftsById } }),
      );
      localStorage.setItem(name, value);
    },
    removeItem: (name) => {
      scoped.removeItem(scopedName(name));
      localStorage.removeItem(name);
    },
  };
}

export function persistedBrowserLandingDraft(
  name: string,
  draftId: string,
  requireScoped: boolean,
): Record<string, unknown> | null {
  const scoped = localStorage.getItem(scopedKey(name, draftId));
  if (scoped !== null || requireScoped) return decoded(scoped);
  const legacy = decoded(localStorage.getItem(name));
  return rows(record(legacy?.state) ?? {}).get(draftId) ?? null;
}
