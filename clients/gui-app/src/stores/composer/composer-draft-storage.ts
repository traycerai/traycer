import type { PersistStorage } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DraftState,
  PendingSubmittedDraftDelete,
} from "./composer-draft-store";
import { stripBase64ImageNodesWithSelection } from "@/lib/composer/strip-base64-image-nodes";
import {
  composerDraftRowKey,
  composerDraftRowPrefix,
  composerDraftStorageKey,
} from "@/lib/persist/keys";
import {
  cancelDeferredJsonWrite,
  deferJsonWrite,
  hasDeferredJsonWrite,
} from "@/lib/persist/deferred-json-storage";
import { appLogger } from "@/lib/logger";
import { migratedLegacyComposerDraftId } from "@/lib/drafts/draft-ids";

export interface ComposerDraftPersistence {
  readonly drafts: Partial<Record<string, DraftState>>;
  readonly pendingSubmittedDraftDeletes: Partial<
    Record<string, PendingSubmittedDraftDelete>
  >;
}

type RowKind = "draft" | "delete";
interface StoredRow {
  readonly revision: string;
  readonly value: unknown;
}
interface ChangedRow {
  readonly kind: RowKind;
  readonly id: string;
  readonly value: DraftState | PendingSubmittedDraftDelete | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRow(key: string): StoredRow | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  const row: unknown = JSON.parse(raw);
  if (!isRecord(row) || typeof row.revision !== "string" || !("value" in row)) {
    throw new Error("Invalid persisted composer draft row");
  }
  return { revision: row.revision, value: row.value };
}

function rowKeys(name: string): string[] {
  const prefix = composerDraftRowPrefix(name);
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

// Keep the source until EVERY destination row is durable. Existing rows win on
// retry, including tombstones, so interrupted migration cannot resurrect a send.
function migrateBlob(name: string): void {
  const raw = window.localStorage.getItem(name);
  if (raw === null) return;
  const blob: unknown = JSON.parse(raw);
  if (
    !isRecord(blob) ||
    !isRecord(blob.state) ||
    !isRecord(blob.state.drafts)
  ) {
    throw new Error("Invalid legacy composer drafts");
  }
  const maps = [
    ["draft", blob.state.drafts],
    ["delete", blob.state.pendingSubmittedDraftDeletes],
  ] as const;
  for (const [kind, rows] of maps) {
    if (!isRecord(rows)) continue;
    for (const [id, value] of Object.entries(rows)) {
      const key = composerDraftRowKey(
        name,
        kind,
        kind === "delete" ? migratedLegacyComposerDraftId(id) : id,
      );
      if (window.localStorage.getItem(key) !== null) continue;
      window.localStorage.setItem(
        key,
        JSON.stringify({ revision: crypto.randomUUID(), value }),
      );
    }
  }
  window.localStorage.removeItem(name);
}

export function createComposerDraftStorage() {
  let previous: ComposerDraftPersistence = {
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  };
  let currentName: string | null = null;
  const baseline = new Map<string, string>();
  const pending = new Map<string, ChangedRow>();
  const encodedContent = new WeakMap<
    JsonContent,
    { readonly json: string; readonly stripped: boolean }
  >();
  let applyingExternal = false;

  function reset(name: string): void {
    if (currentName !== null) cancelDeferredJsonWrite(currentName);
    currentName = name;
    baseline.clear();
    pending.clear();
    previous = { drafts: {}, pendingSubmittedDraftDeletes: {} };
  }

  function encode(row: ChangedRow, revision: string): string {
    if (row.value === undefined || !("content" in row.value)) {
      return JSON.stringify({ revision, value: row.value ?? null });
    }
    const draft = row.value;
    let encoded = encodedContent.get(draft.content);
    if (encoded === undefined) {
      const stripped = stripBase64ImageNodesWithSelection(draft.content, null);
      encoded = {
        json: JSON.stringify(stripped.content),
        stripped: stripped.content !== draft.content,
      };
      encodedContent.set(draft.content, encoded);
    }
    // Caret/ACK/title changes serialize only metadata, reusing the immutable
    // document's encoding (and the strip's caret decision).
    const metadata = JSON.stringify({
      ...draft,
      content: undefined,
      selection: encoded.stripped ? null : draft.selection,
    });
    return `{"revision":${JSON.stringify(revision)},"value":{${metadata.slice(1, -1)},"content":${encoded.json}}}`;
  }

  function flush(): void {
    const failures: unknown[] = [];
    for (const [key, row] of pending) {
      try {
        // localStorage has no atomic CAS across processes. This detects observed
        // conflicts; Web Locks + awaited custody barriers are the upgrade path.
        if ((readRow(key)?.revision ?? null) !== (baseline.get(key) ?? null)) {
          appLogger.debug("[persist] composer draft conflict", {
            chat: row.id,
          });
          throw new Error(
            "This draft changed in another window; local edits are still held here",
          );
        }
        const revision = crypto.randomUUID();
        window.localStorage.setItem(key, encode(row, revision));
        baseline.set(key, revision);
        pending.delete(key);
      } catch (error) {
        // A conflicted row must not prevent unrelated drafts reaching disk on
        // pagehide. Custody barriers still report failure and retain every debt.
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  function adoptNamespace(source: string, target: string): void {
    const sourceKeys = rowKeys(source);
    if (sourceKeys.length === 0 && window.localStorage.getItem(source) === null)
      return;
    // A partial adoption still belongs to the first account. A quota error
    // must never make the remaining anonymous rows available to the next one.
    const ownerKey = `${source}:adopted-by`;
    const owner = window.localStorage.getItem(ownerKey);
    if (owner !== null && owner !== target) return;
    window.localStorage.setItem(ownerKey, target);
    migrateBlob(source);
    for (const key of rowKeys(source)) {
      const destination =
        composerDraftRowPrefix(target) +
        key.slice(composerDraftRowPrefix(source).length);
      const value = window.localStorage.getItem(key);
      if (value !== null && window.localStorage.getItem(destination) === null) {
        window.localStorage.setItem(destination, value);
      }
    }
    for (const key of rowKeys(source)) window.localStorage.removeItem(key);
    window.localStorage.removeItem(ownerKey);
  }

  const storage: PersistStorage<ComposerDraftPersistence> = {
    getItem(name) {
      reset(name);
      const anonymous = composerDraftStorageKey(null);
      if (
        name === anonymous &&
        window.localStorage.getItem(`${anonymous}:adopted-by`) !== null
      ) {
        return {
          version: 1,
          state: { drafts: {}, pendingSubmittedDraftDeletes: {} },
        };
      }
      const source =
        name !== anonymous &&
        window.localStorage.getItem(`${anonymous}:adopted-by`) === name
          ? anonymous
          : name;
      try {
        migrateBlob(source);
        if (source !== name) adoptNamespace(source, name);
      } catch {
        // Quota can stop a migration halfway. Hydrate the retained source as
        // well as completed rows, so the user can still see and save the text.
        appLogger.warn(
          "[persist] composer draft migration incomplete; source retained",
          {},
        );
      }
      const drafts: Record<string, unknown> = {};
      const pendingSubmittedDraftDeletes: Record<string, unknown> = {};
      function readNamespace(namespace: string): void {
        const legacy = window.localStorage.getItem(namespace);
        if (legacy !== null) {
          const blob: unknown = JSON.parse(legacy);
          if (isRecord(blob) && isRecord(blob.state)) {
            if (isRecord(blob.state.drafts))
              Object.assign(drafts, blob.state.drafts);
            if (isRecord(blob.state.pendingSubmittedDraftDeletes)) {
              for (const [id, value] of Object.entries(
                blob.state.pendingSubmittedDraftDeletes,
              )) {
                pendingSubmittedDraftDeletes[
                  migratedLegacyComposerDraftId(id)
                ] = value;
              }
            }
          }
        }
        for (const key of rowKeys(namespace)) {
          const row = readRow(key);
          if (row === null) continue;
          if (namespace === name) baseline.set(key, row.revision);
          const parts = key
            .slice(composerDraftRowPrefix(namespace).length)
            .split(":");
          if (parts.length !== 2) continue;
          const [kind, encodedId] = parts;
          const id = decodeURIComponent(encodedId);
          let rows: Record<string, unknown>;
          if (kind === "draft") rows = drafts;
          else if (kind === "delete") rows = pendingSubmittedDraftDeletes;
          else continue;
          if (row.value === null) delete rows[id];
          else rows[id] = row.value;
        }
      }
      if (source !== name) readNamespace(source);
      readNamespace(name);
      // The store's merge validates legacy and current row values alike.
      return {
        version: 1,
        state: {
          drafts,
          pendingSubmittedDraftDeletes,
        } as ComposerDraftPersistence,
      };
    },
    setItem(name, value) {
      if (currentName !== name) reset(name);
      if (applyingExternal) {
        previous = value.state;
        return;
      }
      if (!hasDeferredJsonWrite(name)) pending.clear();
      function collect(
        kind: RowKind,
        next:
          | ComposerDraftPersistence["drafts"]
          | ComposerDraftPersistence["pendingSubmittedDraftDeletes"],
        before:
          | ComposerDraftPersistence["drafts"]
          | ComposerDraftPersistence["pendingSubmittedDraftDeletes"],
      ): void {
        if (next === before) return;
        for (const id of new Set([
          ...Object.keys(before),
          ...Object.keys(next),
        ])) {
          if (next[id] === before[id]) continue;
          pending.set(composerDraftRowKey(name, kind, id), {
            kind,
            id,
            value: next[id],
          });
        }
      }
      collect("draft", value.state.drafts, previous.drafts);
      collect(
        "delete",
        value.state.pendingSubmittedDraftDeletes,
        previous.pendingSubmittedDraftDeletes,
      );
      previous = value.state;
      if (pending.size > 0) deferJsonWrite(name, flush);
    },
    removeItem(name) {
      reset(name);
      for (const key of rowKeys(name)) window.localStorage.removeItem(key);
      window.localStorage.removeItem(name);
      const anonymous = composerDraftStorageKey(null);
      const ownerKey = `${anonymous}:adopted-by`;
      if (window.localStorage.getItem(ownerKey) === name) {
        for (const key of rowKeys(anonymous))
          window.localStorage.removeItem(key);
        window.localStorage.removeItem(anonymous);
        window.localStorage.removeItem(ownerKey);
      }
    },
  };

  return {
    ...storage,
    rememberSnapshot(state: ComposerDraftPersistence): void {
      previous = state;
    },
    withoutPersistence(apply: () => void): void {
      applyingExternal = true;
      try {
        apply();
      } finally {
        applyingExternal = false;
      }
    },
    adoptNamespace,
    listen(
      readName: () => string,
      apply: (kind: RowKind, id: string, value: unknown) => void,
    ): () => void {
      function applyKey(name: string, key: string): void {
        if (!key.startsWith(composerDraftRowPrefix(name))) return;
        if (hasDeferredJsonWrite(name) && pending.has(key)) {
          appLogger.debug(
            "[persist] composer draft conflict; retaining local edits",
            {},
          );
          return;
        }
        const row = readRow(key);
        const parts = key.slice(composerDraftRowPrefix(name).length).split(":");
        if (parts.length !== 2) return;
        const [kind, encodedId] = parts;
        if (kind !== "draft" && kind !== "delete") return;
        if (row === null) baseline.delete(key);
        else baseline.set(key, row.revision);
        applyingExternal = true;
        try {
          apply(kind, decodeURIComponent(encodedId), row?.value ?? null);
        } finally {
          applyingExternal = false;
        }
      }
      function onStorage(event: StorageEvent): void {
        if (
          event.storageArea !== null &&
          event.storageArea !== window.localStorage
        )
          return;
        const name = readName();
        if (event.key === null) {
          for (const key of [...baseline.keys()]) applyKey(name, key);
        } else {
          applyKey(name, event.key);
        }
      }
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}
