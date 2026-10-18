/**
 * Canvas layout lives in the artifact room at canvas-layout:<artifactId>.
 * The root Y.Map holds v=1, title, and extension fields. Pages, boards and
 * notes are separate named roots with :pages/:boards/:notes suffixes, so two
 * hosts opening an empty layout cannot replace each other's collections.
 * Each collection entry is itself a Y.Map: unrelated fields merge; competing writes to one field
 * use Yjs's last-writer-wins rule. Pages contain name/pos; boards contain
 * x/y/w/h, optional page/title/is_interactive/radius, and pos. Notes contain
 * type (sticky/title/rect/oval/line/arrow/pen/image), x/y, optional w/h/x2/y2,
 * text/color/size/maxW, points (a JSON string), src (an image path), and page.
 * Base-62 fractional positions order pages and boards, never the disk file.
 * All mutators run inside the caller's transaction, with its chosen origin.
 */
import * as Y from "yjs";
import { z } from "zod";

export const CANVAS_LAYOUT_ROOT_PREFIX = "canvas-layout:";
export const CANVAS_LAYOUT_VERSION_FIELD = "v";
export const CANVAS_LAYOUT_TITLE_FIELD = "title";
export const CANVAS_LAYOUT_PAGES_FIELD = "pages";
export const CANVAS_LAYOUT_BOARDS_FIELD = "boards";
export const CANVAS_LAYOUT_NOTES_FIELD = "notes";
export const CANVAS_LAYOUT_POSITION_FIELD = "pos";
export const CANVAS_PAGE_FIELDS = { name: "name", pos: "pos" } as const;
export const CANVAS_BOARD_FIELDS = {
  x: "x",
  y: "y",
  w: "w",
  h: "h",
  page: "page",
  title: "title",
  is_interactive: "is_interactive",
  radius: "radius",
  pos: "pos",
} as const;
export const CANVAS_NOTE_FIELDS = {
  type: "type",
  x: "x",
  y: "y",
  w: "w",
  h: "h",
  x2: "x2",
  y2: "y2",
  text: "text",
  color: "color",
  size: "size",
  maxW: "maxW",
  points: "points",
  src: "src",
  page: "page",
} as const;

export function canvasLayoutRootKey(artifactId: string): string {
  return `${CANVAS_LAYOUT_ROOT_PREFIX}${artifactId}`;
}

export interface CanvasLayoutHandle {
  readonly root: Y.Map<unknown>;
  readonly pages: Y.Map<unknown>;
  readonly boards: Y.Map<unknown>;
  readonly notes: Y.Map<unknown>;
}
export function canvasLayoutPagesKey(artifactId: string): string {
  return `${canvasLayoutRootKey(artifactId)}:pages`;
}
export function canvasLayoutBoardsKey(artifactId: string): string {
  return `${canvasLayoutRootKey(artifactId)}:boards`;
}
export function canvasLayoutNotesKey(artifactId: string): string {
  return `${canvasLayoutRootKey(artifactId)}:notes`;
}
export function openCanvasLayout(
  doc: Y.Doc,
  artifactId: string,
): CanvasLayoutHandle {
  return {
    root: doc.getMap<unknown>(canvasLayoutRootKey(artifactId)),
    pages: doc.getMap<unknown>(canvasLayoutPagesKey(artifactId)),
    boards: doc.getMap<unknown>(canvasLayoutBoardsKey(artifactId)),
    notes: doc.getMap<unknown>(canvasLayoutNotesKey(artifactId)),
  };
}

const number = z.number().finite().optional();
const pageSchema = z
  .object({ id: z.string().optional(), name: z.string().optional() })
  .passthrough();
const boardSchema = z
  .object({
    x: number,
    y: number,
    w: number,
    h: number,
    page: z.string().optional(),
    title: z.string().optional(),
    is_interactive: z.boolean().optional(),
    radius: number,
  })
  .passthrough();
const noteSchema = z
  .object({
    type: z
      .enum([
        "sticky",
        "title",
        "rect",
        "oval",
        "line",
        "arrow",
        "pen",
        "image",
      ])
      .optional(),
    x: number,
    y: number,
    w: number,
    h: number,
    x2: number,
    y2: number,
    text: z.string().optional(),
    color: z.string().optional(),
    size: number,
    maxW: number,
    points: z.string().optional(),
    src: z.string().optional(),
    page: z.string().optional(),
  })
  .passthrough();

/** Missing data is repaired by the host; malformed present fields are rejected. */
export const canvasJsonV1Schema = z
  .object({
    v: z.literal(1).optional(),
    title: z.string().optional(),
    pages: z.array(pageSchema).optional(),
    boards: z.record(z.string(), boardSchema).optional(),
    notes: z.record(z.string(), noteSchema).optional(),
    order: z.array(z.string()).optional(),
  })
  .passthrough();
export type CanvasJsonV1 = z.infer<typeof canvasJsonV1Schema>;
export type CanvasBoard = z.infer<typeof boardSchema>;
export type CanvasNote = z.infer<typeof noteSchema>;
export type CanvasPage = z.infer<typeof pageSchema>;
export interface CanvasLayoutSnapshot {
  readonly v: 1;
  readonly title: string;
  readonly pages: readonly (CanvasPage & {
    id: string;
    name: string;
    pos: string;
  })[];
  readonly boards: Readonly<Record<string, CanvasBoard & { pos: string }>>;
  readonly notes: Readonly<Record<string, CanvasNote>>;
  readonly order: readonly string[];
  readonly extra: Readonly<Record<string, unknown>>;
}
export interface ApplyCanvasJsonOptions {
  readonly protectedBoardPaths: readonly string[];
  /** Last file consumed or projected. Null means full reconciliation. */
  readonly baseline: CanvasJsonV1 | null;
}
export interface CanvasBoardFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rootFields = ["v", "title", "pages", "boards", "notes", "order"];
const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function validPosition(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9A-Za-z]+$/.test(value) &&
    !value.endsWith("0")
  );
}

/** Lexicographic fractional midpoint. Generated keys never end in zero. */
export function between(a: string | null, b: string | null): string {
  if (
    (a !== null && !validPosition(a)) ||
    (b !== null && !validPosition(b)) ||
    (a !== null && b !== null && a >= b)
  )
    throw new Error("Invalid canvas position bounds");
  let prefix = "";
  let lower = a ?? "";
  let upper = b;
  for (;;) {
    const lo = lower.length === 0 ? 0 : alphabet.indexOf(lower[0]);
    const hi =
      upper === null
        ? alphabet.length
        : upper.length === 0
          ? 0
          : alphabet.indexOf(upper[0]);
    if (hi - lo > 1) return prefix + alphabet[Math.floor((lo + hi) / 2)];
    prefix += alphabet[lo];
    lower = lower.slice(1);
    upper = hi === lo && upper !== null ? upper.slice(1) : null;
  }
}

const sequences = new WeakMap<Y.Doc, number>();
function position(
  map: Y.Map<unknown>,
  a: string | null,
  b: string | null,
): string {
  const doc = map.doc;
  if (doc === null)
    throw new Error("Canvas layout must be attached to a Y.Doc");
  const sequence = (sequences.get(doc) ?? 0) + 1;
  sequences.set(doc, sequence);
  // The midpoint differs from the upper bound before its suffix. Appending
  // a fixed-width client id and local sequence keeps it between the bounds,
  // and gives concurrent insertions by distinct Yjs clients distinct ranks.
  return (
    between(a, b) +
    encode62(doc.clientID).padStart(6, "0") +
    encode62(sequence) +
    "V"
  );
}
function encode62(value: number): string {
  let result = "";
  do {
    result = alphabet[value % 62] + result;
    value = Math.floor(value / 62);
  } while (value > 0);
  return result;
}
function child(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const old: unknown = parent.get(key);
  if (old instanceof Y.Map) return old;
  const created = new Y.Map<unknown>();
  parent.set(key, created);
  return created;
}
function existingChild(
  parent: Y.Map<unknown>,
  key: string,
): Y.Map<unknown> | null {
  const value: unknown = parent.get(key);
  return value instanceof Y.Map ? value : null;
}
function object(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries());
}
function sortedEntries(map: Y.Map<unknown> | null): [string, Y.Map<unknown>][] {
  const entries: [string, Y.Map<unknown>][] = [];
  for (const [key, value] of map ?? [])
    if (value instanceof Y.Map) entries.push([key, value]);
  return entries.sort(
    ([a, av], [b, bv]) =>
      compare(readPosition(av), readPosition(bv)) || compare(a, b),
  );
}
function readPosition(map: Y.Map<unknown>): string {
  const value = map.get("pos");
  return validPosition(value) ? value : "";
}

export function readCanvasLayout(
  layout: CanvasLayoutHandle,
): CanvasLayoutSnapshot {
  const map = layout.root;
  const pages: (CanvasPage & { id: string; name: string; pos: string })[] = [];
  for (const [id, entry] of sortedEntries(layout.pages)) {
    const parsed = pageSchema.safeParse(object(entry));
    if (parsed.success)
      pages.push({
        ...parsed.data,
        id,
        name: parsed.data.name ?? id,
        pos: readPosition(entry),
      });
  }
  const boards: [string, CanvasBoard & { pos: string }][] = [];
  for (const [path, entry] of sortedEntries(layout.boards)) {
    const parsed = boardSchema.safeParse(object(entry));
    if (parsed.success)
      boards.push([path, { ...parsed.data, pos: readPosition(entry) }]);
  }
  const notes: [string, CanvasNote][] = [];
  for (const [id, entry] of sortedEntries(layout.notes)) {
    const parsed = noteSchema.safeParse(object(entry));
    if (parsed.success) notes.push([id, parsed.data]);
  }
  const title = map.get("title");
  return {
    v: 1,
    title: typeof title === "string" ? title : "",
    pages,
    boards: Object.fromEntries(boards),
    notes: Object.fromEntries(notes),
    order: boards.map(([path]) => path),
    extra: Object.fromEntries(
      [...map.entries()].filter(([key]) => !rootFields.includes(key)),
    ),
  };
}
function withoutPosition(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== "pos"),
  );
}
export function projectCanvasJson(
  snapshot: CanvasLayoutSnapshot,
): CanvasJsonV1 {
  return {
    ...snapshot.extra,
    v: snapshot.v,
    title: snapshot.title,
    pages: snapshot.pages.map(({ pos: _pos, ...page }) => page),
    boards: Object.fromEntries(
      Object.entries(snapshot.boards).map(([path, { pos: _pos, ...board }]) => [
        path,
        board,
      ]),
    ),
    notes: { ...snapshot.notes },
    order: [...snapshot.order],
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
export function formatCanvasJson(json: CanvasJsonV1): string {
  const fields = [
    ...rootFields,
    ...Object.keys(json)
      .filter((key) => !rootFields.includes(key))
      .sort(compare),
  ];
  const ordered = Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(json, key))
      .map((key) => [key, stable(json[key])]),
  );
  return JSON.stringify(ordered, null, 2) + "\n";
}

/** Writes individual leaves, retaining omitted extension fields on a full apply. */
function patchFields(
  map: Y.Map<unknown>,
  next: Record<string, unknown>,
  base: Record<string, unknown> | null,
  known: readonly string[],
): void {
  const keys = new Set([
    ...Object.keys(next),
    ...(base === null
      ? [...map.keys()].filter((key) => known.includes(key))
      : Object.keys(base)),
  ]);
  for (const key of keys) {
    if (base !== null && equal(base[key], next[key])) continue;
    const value = next[key];
    if (value === undefined) {
      if (map.has(key)) map.delete(key);
    } else if (!equal(map.get(key), value)) map.set(key, value);
  }
}
function pageRecords(
  pages: readonly CanvasPage[] | undefined,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    (pages ?? []).flatMap((page) => {
      if (page.id === undefined) return [];
      const { id, pos: _pos, ...fields } = page;
      return [[id, fields]];
    }),
  );
}
function reconcileEntries(
  map: Y.Map<unknown>,
  next: Record<string, Record<string, unknown>>,
  base: Record<string, Record<string, unknown>> | null,
  known: readonly string[],
  protectedIds: ReadonlySet<string>,
): void {
  for (const [id, fields] of Object.entries(next)) {
    const previous = base !== null && Object.hasOwn(base, id) ? base[id] : null;
    const existing = existingChild(map, id);
    if (
      previous !== null &&
      equal(previous, fields) &&
      (existing !== null || !protectedIds.has(id))
    )
      continue;
    patchFields(
      existing ?? child(map, id),
      fields,
      existing === null ? null : previous,
      known,
    );
  }
  for (const id of base === null ? [...map.keys()] : Object.keys(base)) {
    if (!Object.hasOwn(next, id) && !protectedIds.has(id)) map.delete(id);
  }
}

/** Keep the longest increasing subsequence of positions; move only the rest. */
function reorder(map: Y.Map<unknown>, ids: readonly string[]): void {
  const ordered = [...new Set(ids)].filter(
    (id) => existingChild(map, id) !== null,
  );
  const tails: number[] = [];
  const previous: number[] = [];
  const positions = ordered.map((id) => readPosition(child(map, id)));
  for (let i = 0; i < ordered.length; i++) {
    const rank = positions[i];
    if (!validPosition(rank)) continue;
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (positions[tails[mid]] < rank) low = mid + 1;
      else high = mid;
    }
    previous[i] = low === 0 ? -1 : tails[low - 1];
    tails[low] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i]) keep.add(i);
  let left: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const entry = child(map, ordered[i]);
    if (!keep.has(i)) {
      let right: string | null = null;
      for (let j = i + 1; j < ordered.length; j++)
        if (keep.has(j)) {
          right = positions[j];
          break;
        }
      entry.set("pos", position(map, left, right));
    }
    left = readPosition(entry);
  }
}
function reconcileOrder(
  map: Y.Map<unknown>,
  requested: readonly string[] | undefined,
  baseline: readonly string[] | undefined,
  full: boolean,
): void {
  const current = sortedEntries(map).map(([id]) => id);
  const changed = full || !equal(requested, baseline);
  const desired = changed ? [...(requested ?? []), ...current] : current;
  reorder(map, desired);
}

export function applyCanvasJson(
  layout: CanvasLayoutHandle,
  parsed: CanvasJsonV1,
  options: ApplyCanvasJsonOptions,
): void {
  const map = layout.root;
  const baseline = options.baseline;
  const scalars = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) => !["pages", "boards", "notes", "order"].includes(key),
    ),
  );
  const baseScalars =
    baseline === null
      ? null
      : Object.fromEntries(
          Object.entries(baseline).filter(
            ([key]) => !["pages", "boards", "notes", "order"].includes(key),
          ),
        );
  patchFields(map, scalars, baseScalars, ["v", "title"]);
  const { pages, boards, notes } = layout;
  reconcileEntries(
    pages,
    pageRecords(parsed.pages),
    baseline === null ? null : pageRecords(baseline.pages),
    ["name"],
    new Set(),
  );
  const boardEntries = Object.fromEntries(
    Object.entries(parsed.boards ?? {}).map(([id, fields]) => [
      id,
      withoutPosition(fields),
    ]),
  );
  const baseBoards =
    baseline === null
      ? null
      : Object.fromEntries(
          Object.entries(baseline.boards ?? {}).map(([id, fields]) => [
            id,
            withoutPosition(fields),
          ]),
        );
  reconcileEntries(
    boards,
    boardEntries,
    baseBoards,
    Object.keys(boardSchema.shape),
    new Set(options.protectedBoardPaths),
  );
  reconcileEntries(
    notes,
    parsed.notes ?? {},
    baseline === null ? null : (baseline.notes ?? {}),
    Object.keys(noteSchema.shape),
    new Set(),
  );
  reconcileOrder(
    pages,
    parsed.pages?.flatMap((page) => (page.id === undefined ? [] : [page.id])),
    baseline?.pages?.flatMap((page) =>
      page.id === undefined ? [] : [page.id],
    ),
    baseline === null,
  );
  reconcileOrder(boards, parsed.order, baseline?.order, baseline === null);
  clearDanglingPageReferences(layout);
}

export function setBoardFrame(
  layout: CanvasLayoutHandle,
  path: string,
  frame: CanvasBoardFrame,
): void {
  const boards = layout.boards,
    entry = child(boards, path);
  patchFields(entry, { ...frame }, null, ["x", "y", "w", "h"]);
  reconcileOrder(boards, undefined, undefined, false);
}
export function moveBoardOrder(
  layout: CanvasLayoutHandle,
  path: string,
  beforePath: string | null,
): void {
  moveEntry(layout.boards, path, beforePath);
}
function moveEntry(
  map: Y.Map<unknown>,
  id: string,
  beforeId: string | null,
): void {
  const entry = existingChild(map, id);
  if (entry === null || id === beforeId) return;
  const old = sortedEntries(map).map(([key]) => key);
  const ids = old.filter((key) => key !== id);
  const index = beforeId === null ? ids.length : ids.indexOf(beforeId);
  if (index < 0) return;
  ids.splice(index, 0, id);
  if (equal(old, ids) && validPosition(entry.get("pos"))) return;
  const left =
    index === 0 ? null : readPosition(child(map, ids[index - 1])) || null;
  const right =
    index === ids.length - 1
      ? null
      : readPosition(child(map, ids[index + 1])) || null;
  entry.set("pos", position(map, left, right));
}
export function setPageName(
  layout: CanvasLayoutHandle,
  id: string,
  name: string,
): void {
  const page = existingChild(layout.pages, id);
  if (page !== null && page.get("name") !== name) page.set("name", name);
}
export const renamePage = setPageName;
export function addPage(
  layout: CanvasLayoutHandle,
  id: string,
  name: string,
  beforeId: string | null,
): void {
  const pages = layout.pages,
    page = child(pages, id);
  if (page.get("name") !== name) page.set("name", name);
  reconcileOrder(pages, undefined, undefined, false);
  moveEntry(pages, id, beforeId);
}
export function removePage(layout: CanvasLayoutHandle, id: string): void {
  const pages = layout.pages;
  if (pages.size <= 1 || !pages.has(id)) return;
  pages.delete(id);
  clearDanglingPageReferences(layout);
}
function clearDanglingPageReferences(layout: CanvasLayoutHandle): void {
  for (const collection of [layout.boards, layout.notes])
    for (const [, entry] of sortedEntries(collection)) {
      const page = entry.get("page");
      if (typeof page === "string" && !layout.pages.has(page))
        entry.delete("page");
    }
}
export function upsertNote(
  layout: CanvasLayoutHandle,
  id: string,
  note: CanvasNote,
): void {
  patchFields(child(layout.notes, id), note, {}, []);
}
export function removeNote(layout: CanvasLayoutHandle, id: string): void {
  layout.notes.delete(id);
}
