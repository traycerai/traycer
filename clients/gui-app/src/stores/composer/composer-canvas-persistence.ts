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

export type CanvasAnnotationsByChat = Partial<
  Record<string, WindowCanvasAnnotations>
>;

interface WindowCanvasAnnotations {
  readonly records: ReadonlyArray<CanvasAnnotationRecord>;
  readonly order: ReadonlyArray<string>;
  readonly witness: string | null;
}

type PersistedCanvasEntry = readonly [
  string,
  ReadonlyArray<
    | CanvasAnnotationRecord
    | {
        kind: "draft-annotation-order";
        ids: readonly string[];
        witness: string;
      }
  >,
];

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
        {
          records: canvasAnnotations(parseBrowserAnnotationRecords(records)),
          ...savedAnnotationOrder(records),
        },
      ]),
    );
  } catch {
    return {};
  }
}

function savedAnnotationOrder(
  records: unknown,
): Pick<WindowCanvasAnnotations, "order" | "witness"> {
  if (!Array.isArray(records)) return { order: [], witness: null };
  for (const entry of records) {
    if (!isRecord(entry) || entry.kind !== "draft-annotation-order") continue;
    const ids = entry.ids;
    if (Array.isArray(ids)) {
      return {
        order: ids.filter((id): id is string => typeof id === "string"),
        witness: typeof entry.witness === "string" ? entry.witness : null,
      };
    }
  }
  return { order: [], witness: null };
}

export function restoreWindowAnnotationOrder(
  shared: ReadonlyArray<BrowserAnnotationRecord>,
  windowAnnotations: WindowCanvasAnnotations,
): ReadonlyArray<BrowserAnnotationRecord> {
  if (windowAnnotations.order.length === 0) {
    return [...shared, ...windowAnnotations.records];
  }
  const records = new Map(
    [...shared, ...windowAnnotations.records].map((record) => [
      record.annotationId,
      record,
    ]),
  );
  const ordered: BrowserAnnotationRecord[] = [];
  for (const id of windowAnnotations.order) {
    const record = records.get(id);
    if (record === undefined) continue;
    ordered.push(record);
    records.delete(id);
  }
  return [...ordered, ...records.values()];
}

/** Complete sidecars stay local to their native window, including across reload. */
export function persistWindowCanvasAnnotations(
  drafts: Partial<
    Record<
      string,
      {
        readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
        readonly ordinaryCanvasWitness?: string | undefined;
      }
    >
  >,
): void {
  const target = windowStorage();
  if (target === null) return;
  const entries = Object.entries(drafts).flatMap<PersistedCanvasEntry>(
    ([chatId, draft]) => {
      if (draft === undefined) return [];
      const records = canvasAnnotations(draft.browserAnnotations);
      if (records.length === 0) return [];
      if (draft.ordinaryCanvasWitness === undefined) return [[chatId, records]];
      // Earlier readers skip the order metadata while keeping the Canvas cards.
      return [
        [
          chatId,
          [
            ...records,
            {
              kind: "draft-annotation-order",
              witness: draft.ordinaryCanvasWitness,
              ids: draft.browserAnnotations.map(
                (annotation) => annotation.annotationId,
              ),
            },
          ],
        ],
      ];
    },
  );
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
          ).flatMap((annotations) => annotations?.records ?? []),
        );
      }
    }
  } catch {
    // In-memory roots still protect the current window if storage is blocked.
  }
  return collectAnnotationImageHashes(records);
}
