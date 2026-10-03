import { vi, type MockInstance } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { cancelDeferredJsonWrites } from "@/lib/persist/deferred-json-storage";
import {
  composerDraftRowKey,
  composerDraftRowPrefix,
  composerDraftStorageKey,
} from "@/lib/persist/keys";
import {
  clearComposerDraftPersistence,
  EMPTY_COMPOSER_DRAFT,
  useComposerDraftStore,
  type DraftState,
} from "../composer-draft-store";

/** The anonymous namespace: also the legacy single-blob key. */
export const ANON_NAME = composerDraftStorageKey(null);

export type RowKind = "draft" | "delete";

/** Row values are stored as `{ revision, value }`; `value: null` is a tombstone. */
export interface StoredRow {
  readonly revision: string;
  readonly value: unknown;
}

export function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export function draftWith(text: string): DraftState {
  return { ...EMPTY_COMPOSER_DRAFT, content: textDoc(text) };
}

export function draftWithFields(
  text: string,
  overrides: Partial<DraftState>,
): DraftState {
  return { ...draftWith(text), ...overrides };
}

export function rowKey(kind: RowKind, id: string, name: string): string {
  return composerDraftRowKey(name, kind, id);
}

export function rowKeys(name: string): string[] {
  const prefix = composerDraftRowPrefix(name);
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys.sort();
}

export function readStoredRow(
  kind: RowKind,
  id: string,
  name: string,
): StoredRow | null {
  const raw = window.localStorage.getItem(rowKey(kind, id, name));
  if (raw === null) return null;
  return JSON.parse(raw) as StoredRow;
}

/** The persisted draft value of a chat, or `undefined` when absent or tombstoned. */
export function readDraftRow(
  chatId: string,
  name: string,
): DraftState | undefined {
  const value = readStoredRow("draft", chatId, name)?.value;
  return value === null || value === undefined
    ? undefined
    : (value as DraftState);
}

/** Every raw row under a namespace, for asserting that nothing was rewritten. */
export function rawRows(name: string): string | null {
  const keys = rowKeys(name);
  if (keys.length === 0) return null;
  return keys
    .map((key) => `${key}=${window.localStorage.getItem(key) ?? ""}`)
    .join("\n");
}

export function seedRow(
  kind: RowKind,
  id: string,
  row: StoredRow,
  name: string,
): void {
  window.localStorage.setItem(rowKey(kind, id, name), JSON.stringify(row));
}

/** The persisted-state shape a store hydrates from; either map may be absent. */
type PersistedState = Partial<
  Record<"drafts" | "pendingSubmittedDraftDeletes", Record<string, unknown>>
>;

/** Seed both row kinds from a persisted-state shape. */
export function seedRows(state: PersistedState, name: string): void {
  let counter = 0;
  for (const [id, value] of Object.entries(state.drafts ?? {})) {
    seedRow(
      "draft",
      id,
      { value, revision: `seed-${String((counter += 1))}` },
      name,
    );
  }
  for (const [id, value] of Object.entries(
    state.pendingSubmittedDraftDeletes ?? {},
  )) {
    seedRow(
      "delete",
      id,
      { value, revision: `seed-${String((counter += 1))}` },
      name,
    );
  }
}

export function seedLegacyBlob(state: PersistedState, name: string): void {
  window.localStorage.setItem(name, JSON.stringify({ version: 1, state }));
}

/**
 * Put the store and its adapter on a clean, empty namespace - the ACTIVE one:
 * an account-scoped store stays on its account. The production clear resets the
 * adapter's baseline (the revisions it last observed) and empties every live
 * draft; the rest of localStorage is then cleared and the store rehydrated, so
 * the test's map matches the now-empty disk. Without the baseline reset a
 * later custody write on a chat whose row this clear removed reports a
 * conflict against a row that no longer exists.
 */
export async function resetComposerDraftPersistence(): Promise<void> {
  cancelDeferredJsonWrites();
  clearComposerDraftPersistence();
  window.localStorage.clear();
  await useComposerDraftStore.persist.rehydrate();
  cancelDeferredJsonWrites();
}

/**
 * `localStorage.setItem` throws a quota error for the keys `shouldFail` names
 * and behaves normally for the rest. Some environments install the mock
 * storage's methods as own properties, so the spy targets whichever is live.
 */
export function failWritesWhere(
  shouldFail: (key: string) => boolean,
): MockInstance<typeof Storage.prototype.setItem> {
  const target: Storage = Object.hasOwn(window.localStorage, "setItem")
    ? window.localStorage
    : Storage.prototype;
  const original = target.setItem.bind(window.localStorage);
  return vi.spyOn(target, "setItem").mockImplementation((key, value) => {
    if (shouldFail(key)) {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    original(key, value);
  });
}
