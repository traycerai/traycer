import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  collectAnnotationImageHashes,
  parseBrowserAnnotationRecords,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  composerCanvasAnnotationsKey,
  composerCanvasAnnotationsKeyPrefix,
} from "@/lib/persist";

type CanvasAnnotationsByChat = Partial<
  Record<string, ReadonlyArray<CanvasAnnotationRecord>>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canvasAnnotations(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): ReadonlyArray<CanvasAnnotationRecord> {
  return records.filter(
    (record): record is CanvasAnnotationRecord =>
      record.source.kind === "canvas",
  );
}

function windowStorage(): {
  readonly storage: Storage;
  readonly key: string;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
    const windows: unknown = isRecord(runnerHost) ? runnerHost.windows : null;
    if (
      isRecord(windows) &&
      typeof windows.windowId === "string" &&
      windows.windowId.length > 0
    ) {
      return {
        storage: window.localStorage,
        key: composerCanvasAnnotationsKey(windows.windowId),
      };
    }
    // A web tab has no shell window identity. Its session storage survives a
    // reload without making the draft part of the shared localStorage bucket.
    return {
      storage: window.sessionStorage,
      key: composerCanvasAnnotationsKey("session"),
    };
  } catch {
    return null;
  }
}

function parseCanvasAnnotations(raw: string | null): CanvasAnnotationsByChat {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([chatId, records]) => [
        chatId,
        canvasAnnotations(parseBrowserAnnotationRecords(records)),
      ]),
    );
  } catch {
    return {};
  }
}

/** Complete sidecars stay local to their native window, including across reload. */
export function persistWindowCanvasAnnotations(
  drafts: Partial<
    Record<
      string,
      { readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord> }
    >
  >,
): void {
  const target = windowStorage();
  if (target === null) return;
  const entries = Object.entries(drafts).flatMap(([chatId, draft]) => {
    const records =
      draft === undefined ? [] : canvasAnnotations(draft.browserAnnotations);
    return records.length === 0 ? [] : [[chatId, records]];
  });
  try {
    if (entries.length === 0) target.storage.removeItem(target.key);
    else
      target.storage.setItem(
        target.key,
        JSON.stringify(Object.fromEntries(entries)),
      );
  } catch {
    // Storage may be unavailable or full; the in-memory draft remains sendable.
  }
}

export function readWindowCanvasAnnotations(): CanvasAnnotationsByChat {
  const target = windowStorage();
  if (target === null) return {};
  try {
    return parseCanvasAnnotations(target.storage.getItem(target.key));
  } catch {
    return {};
  }
}

/** A second renderer's shared image GC must retain crops saved by other windows. */
export function persistedCanvasAnnotationImageHashes(): ReadonlyArray<string> {
  if (typeof window === "undefined") return [];
  const records: CanvasAnnotationRecord[] = [];
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (
          key === null ||
          !key.startsWith(composerCanvasAnnotationsKeyPrefix())
        )
          continue;
        records.push(
          ...Object.values(
            parseCanvasAnnotations(storage.getItem(key)),
          ).flatMap((annotations) => annotations ?? []),
        );
      }
    }
  } catch {
    // In-memory roots still protect the current window if storage is blocked.
  }
  return collectAnnotationImageHashes(records);
}
