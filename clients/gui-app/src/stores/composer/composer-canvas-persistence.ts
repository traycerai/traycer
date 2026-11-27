import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  draftBaseSchema,
  draftCloudDocumentSchema,
  type DraftBase,
  type DraftCloudDocument,
} from "@traycer/protocol/host/drafts";
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

export type OrdinaryRecoveryDrafts = Partial<
  Record<string, DraftCloudDocument>
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

export interface OrdinaryDraftScopeBinding {
  readonly ownerId: string;
  readonly scopeId: string;
}

export interface PersistedOrdinaryDraftBase {
  readonly draftId: string;
  readonly base: DraftBase;
  readonly kind: "live" | "tombstone";
  readonly operationId: string | null | undefined;
  readonly accepted: DraftBase | null;
  readonly ambiguous: boolean;
}

export interface PersistedModalDraftSidecar {
  readonly records: ReadonlyArray<BrowserAnnotationRecord>;
  readonly dirty: boolean;
}

export type PersistedModalDraftSidecars = Readonly<
  Partial<Record<string, PersistedModalDraftSidecar>>
>;

export type OrdinaryDraftEditorSurface = "chat" | "modal" | "landing";
export type OrdinaryDraftAcceptance = Pick<
  DraftCloudDocument,
  "draftId" | "base" | "operationId"
>;
type OrdinaryDraftEditors = Partial<
  Record<
    OrdinaryDraftEditorSurface,
    {
      readonly value: unknown;
      readonly hashes: ReadonlyArray<string>;
    }
  >
>;

interface OrdinaryDraftWindowScope {
  readonly binding: OrdinaryDraftScopeBinding;
  readonly drafts: OrdinaryRecoveryDrafts;
  readonly bases: ReadonlyArray<PersistedOrdinaryDraftBase>;
  readonly modalSidecars: PersistedModalDraftSidecars;
  readonly editors: OrdinaryDraftEditors;
  readonly frontiers: ReadonlyArray<{
    readonly peerId: string;
    readonly seq: number;
  }>;
}

function ordinaryDraftWindowStorage(): {
  readonly storage: Storage;
  readonly key: string;
} | null {
  const target = windowStorage();
  if (target === null) return null;
  try {
    return { storage: window.localStorage, key: target.key };
  } catch {
    return null;
  }
}

function parseOrdinaryDraftBases(value: unknown): PersistedOrdinaryDraftBase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record): PersistedOrdinaryDraftBase[] => {
    if (
      !isRecord(record) ||
      typeof record.draftId !== "string" ||
      (record.kind !== "live" && record.kind !== "tombstone")
    )
      return [];
    const base = draftBaseSchema.safeParse(record.base);
    const accepted = draftBaseSchema.nullable().safeParse(record.accepted);
    if (!base.success || !accepted.success) return [];
    return [
      {
        draftId: record.draftId,
        base: base.data,
        kind: record.kind,
        operationId:
          typeof record.operationId === "string" || record.operationId === null
            ? record.operationId
            : undefined,
        accepted: accepted.data,
        ambiguous: record.ambiguous === true,
      },
    ];
  });
}

function parseOrdinaryDraftEditors(value: unknown): OrdinaryDraftEditors {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    (["chat", "modal", "landing"] as const).flatMap((surface) => {
      const editor = value[surface];
      if (!isRecord(editor) || !Array.isArray(editor.hashes)) return [];
      return [
        [
          surface,
          {
            value: editor.value,
            hashes: editor.hashes.filter(
              (hash): hash is string =>
                typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
            ),
          },
        ],
      ];
    }),
  );
}

function readOrdinaryDraftWindowScopes(target: {
  readonly storage: Storage;
  readonly key: string;
}): OrdinaryDraftWindowScope[] {
  const raw = target.storage.getItem(`${target.key}:ordinary-drafts`);
  const saved: unknown = raw === null ? null : JSON.parse(raw);
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((scope): OrdinaryDraftWindowScope[] => {
    if (!isRecord(scope) || !isRecord(scope.binding) || !isRecord(scope.drafts))
      return [];
    const { ownerId, scopeId } = scope.binding;
    if (typeof ownerId !== "string" || typeof scopeId !== "string") return [];
    return [
      {
        binding: { ownerId, scopeId },
        drafts: Object.fromEntries(
          Object.entries(scope.drafts).flatMap(([draftId, value]) => {
            const parsed = draftCloudDocumentSchema.safeParse(value);
            return parsed.success && parsed.data.draftId === draftId
              ? [[draftId, parsed.data]]
              : [];
          }),
        ),
        bases: parseOrdinaryDraftBases(scope.bases),
        modalSidecars: isRecord(scope.modalSidecars)
          ? Object.fromEntries(
              Object.entries(scope.modalSidecars).flatMap(([epicId, value]) =>
                isRecord(value)
                  ? [
                      [
                        epicId,
                        {
                          records: parseBrowserAnnotationRecords(value.records),
                          dirty: value.dirty === true,
                        },
                      ],
                    ]
                  : [],
              ),
            )
          : {},
        editors: parseOrdinaryDraftEditors(scope.editors),
        frontiers: Array.isArray(scope.frontiers)
          ? scope.frontiers.flatMap((entry) =>
              isRecord(entry) &&
              typeof entry.peerId === "string" &&
              typeof entry.seq === "number" &&
              Number.isSafeInteger(entry.seq) &&
              entry.seq >= 0
                ? [{ peerId: entry.peerId, seq: entry.seq }]
                : [],
            )
          : [],
      },
    ];
  });
}

export function updateWindowOrdinaryDraftScope(
  binding: OrdinaryDraftScopeBinding,
  update: Partial<
    Pick<
      OrdinaryDraftWindowScope,
      "drafts" | "bases" | "modalSidecars" | "editors" | "frontiers"
    >
  >,
): boolean {
  const target = ordinaryDraftWindowStorage();
  if (target === null) return false;
  try {
    const scopes = readOrdinaryDraftWindowScopes(target);
    const index = scopes.findIndex(
      (scope) =>
        scope.binding.ownerId === binding.ownerId &&
        scope.binding.scopeId === binding.scopeId,
    );
    const previous = index < 0 ? undefined : scopes.splice(index, 1)[0];
    scopes.push({
      binding,
      drafts: previous?.drafts ?? {},
      bases: previous?.bases ?? [],
      modalSidecars: previous?.modalSidecars ?? {},
      editors: previous?.editors ?? {},
      frontiers: previous?.frontiers ?? [],
      ...update,
    });
    target.storage.setItem(
      `${target.key}:ordinary-drafts`,
      JSON.stringify(scopes),
    );
    return true;
  } catch {
    return false;
  }
}

let ordinaryDraftScopeBinding: OrdinaryDraftScopeBinding | null = null;
const ordinaryDraftScopeListeners = new Set<
  (binding: OrdinaryDraftScopeBinding | null) => void
>();

export function currentOrdinaryDraftScopeBinding(): OrdinaryDraftScopeBinding | null {
  return ordinaryDraftScopeBinding;
}

export function setOrdinaryDraftScopeBinding(
  binding: OrdinaryDraftScopeBinding | null,
): void {
  if (
    ordinaryDraftScopeBinding?.ownerId === binding?.ownerId &&
    ordinaryDraftScopeBinding?.scopeId === binding?.scopeId
  )
    return;
  ordinaryDraftScopeBinding = binding;
  for (const listener of ordinaryDraftScopeListeners) listener(binding);
}

export function onOrdinaryDraftScopeChanged(
  listener: (binding: OrdinaryDraftScopeBinding | null) => void,
): void {
  ordinaryDraftScopeListeners.add(listener);
}

export function readOrdinaryDraftEditor(
  surface: OrdinaryDraftEditorSurface,
): unknown {
  const binding = ordinaryDraftScopeBinding;
  return binding === null
    ? undefined
    : readWindowOrdinaryDraftScope(binding.ownerId, binding.scopeId)?.editors[
        surface
      ]?.value;
}

export function persistOrdinaryDraftEditor(
  surface: OrdinaryDraftEditorSurface,
  value: unknown,
  hashes: ReadonlyArray<string>,
  changes:
    | {
        readonly modalSidecars?: PersistedModalDraftSidecars;
        readonly accepted?: OrdinaryDraftAcceptance;
      }
    | undefined,
): boolean {
  const binding = ordinaryDraftScopeBinding;
  if (binding === null) return false;
  const stored = readWindowOrdinaryDraftScope(binding.ownerId, binding.scopeId);
  return updateWindowOrdinaryDraftScope(binding, {
    editors: { ...stored?.editors, [surface]: { value, hashes } },
    ...(changes?.modalSidecars === undefined
      ? {}
      : { modalSidecars: changes.modalSidecars }),
    ...acceptOrdinaryEditor(stored, changes?.accepted),
  });
}

function acceptOrdinaryEditor(
  stored: OrdinaryDraftWindowScope | null,
  accepted: OrdinaryDraftAcceptance | undefined,
): Partial<Pick<OrdinaryDraftWindowScope, "drafts" | "bases">> {
  if (accepted === undefined) return {};
  const { draftId, base, operationId } = accepted;
  const previous = stored?.bases.find((record) => record.draftId === draftId);
  const next: PersistedOrdinaryDraftBase =
    previous === undefined || base.revision > previous.base.revision
      ? {
          draftId,
          base,
          kind: "live",
          operationId,
          accepted: base,
          ambiguous: false,
        }
      : { ...previous, accepted: base };
  return {
    drafts: Object.fromEntries(
      Object.entries(stored?.drafts ?? {}).filter(([id]) => id !== draftId),
    ),
    bases: [
      ...(stored?.bases ?? []).filter((record) => record.draftId !== draftId),
      next,
    ],
  };
}
export function readWindowOrdinaryDraftScope(
  ownerId: string,
  scopeId: string | null,
): OrdinaryDraftWindowScope | null {
  const target = ordinaryDraftWindowStorage();
  if (target === null) return null;
  try {
    return (
      readOrdinaryDraftWindowScopes(target).findLast(
        (scope) =>
          scope.binding.ownerId === ownerId &&
          (scopeId === null || scope.binding.scopeId === scopeId),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function persistedOrdinaryRecoveryImageHashes(): ReadonlyArray<string> {
  const target = ordinaryDraftWindowStorage();
  if (target === null) return [];
  try {
    return readOrdinaryDraftWindowScopes(target).flatMap((scope) => [
      ...Object.values(scope.drafts).flatMap(
        (draft) => draft?.head.portable.blobHashes ?? [],
      ),
      ...collectAnnotationImageHashes(
        Object.values(scope.modalSidecars).flatMap(
          (sidecar) => sidecar?.records ?? [],
        ),
      ),
      ...Object.values(scope.editors).flatMap((editor) => editor.hashes),
    ]);
  } catch {
    throw new Error("Ordinary draft custody roots are unavailable");
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
