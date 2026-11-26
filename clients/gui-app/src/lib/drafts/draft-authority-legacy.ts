import { isRecord } from "@/lib/editor/prosemirror-json";
import { recordMapStoragePrefix } from "@/lib/persist/keys";

function parseLegacyValue(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value;
  } catch {
    return undefined;
  }
}

export function readLegacyDraftState(
  key: string,
): Record<string, unknown> | null {
  const snapshot = parseLegacyValue(localStorage.getItem(key));
  return isRecord(snapshot) && isRecord(snapshot.state) ? snapshot.state : null;
}

export function readLegacyDraftRecords(
  key: string,
  field: string,
): ReadonlyMap<string, Record<string, unknown> | null> {
  const values = readLegacyDraftState(key)?.[field];
  const records = new Map<string, Record<string, unknown> | null>();
  if (isRecord(values)) {
    for (const [id, value] of Object.entries(values)) {
      if (id.length > 0 && isRecord(value)) records.set(id, value);
    }
  }

  const prefix = recordMapStoragePrefix(key);
  for (let index = 0; index < localStorage.length; index += 1) {
    const recordKey = localStorage.key(index);
    if (recordKey === null || !recordKey.startsWith(prefix)) continue;
    let id: string;
    try {
      id = decodeURIComponent(recordKey.slice(prefix.length));
    } catch {
      continue;
    }
    if (id.length === 0) continue;
    const value = parseLegacyValue(localStorage.getItem(recordKey));
    if (value === null || isRecord(value)) records.set(id, value);
  }
  return records;
}
