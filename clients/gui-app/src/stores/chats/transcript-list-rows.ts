import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/**
 * # The list the transcript draws: hydrated rows and placeholders together
 *
 * On the windowed line the renderer holds bodies for only part of the
 * transcript, but the list has to be `rowCount` long anyway - otherwise
 * scrolling up reaches the top of what happens to be loaded rather than the top
 * of the chat, and the viewport can never ask for anything it does not already
 * have. This module is the merge that makes the list full length.
 *
 * ## A placeholder is its own row type, never a partial `ChatMessage`
 *
 * Overview decision D2, and it is load-bearing rather than tidy. A partial
 * `ChatMessage` would have to lie about `content`, `segments` and `createdAt`,
 * and every consumer that reads those would silently get the lie. Worse, the
 * renderer's row comparators are keyed on `ChatMessage` fields: a row that went
 * from "empty content" to "real content" without changing any compared field
 * would keep its stale rendering, which is the `CHAT_MESSAGE_FIELD_UNCHANGED`
 * freeze-stale-row class this feature has already been bitten by. A distinct
 * `kind` sidesteps the whole class - a hydration transition changes the row's
 * `kind`, which nothing can compare its way past.
 *
 * ## Placement comes from the SPANS, not from the skeleton
 *
 * The obvious implementation reads `skeleton[ordinal].rowId` to decide which
 * rendered row belongs where. That breaks while chunks are still streaming: the
 * skeleton is deliberately SPARSE, so a hydrated row whose ordinal is still a
 * hole would fail to place, fall through to the live tail, and appear twice -
 * once as content at the bottom and once as a placeholder in its real position.
 *
 * `HydratedSpan.rowIds` carries "one row id per row served, in order", so the
 * spans already know the ordinal of every row the client holds a body for, and
 * they know it independently of how much skeleton has arrived. The skeleton is
 * consulted only for rows that are NOT hydrated, which is exactly what it is
 * for.
 *
 * ## What lands after the last ordinal
 *
 * Pending sends, the live assistant row, and records the index has not placed
 * yet (`TranscriptWindow.liveMessages`) all render without owning an ordinal.
 * They go after every ordinal, which is also where they belong
 * chronologically - an unplaced record is the newest thing the client has.
 */

export type TranscriptListRow =
  | {
      readonly kind: "hydrated";
      /** Stable React/LegendList key. The row id for a placed row. */
      readonly key: string;
      /**
       * Its place in the transcript, or `null` for a row that owns no ordinal -
       * a pending send, the live turn, or a record the index has not placed.
       * Also `null` on the legacy line, which has no ordinal space at all.
       */
      readonly ordinal: number | null;
      readonly model: ChatMessageModel;
    }
  | {
      readonly kind: "placeholder";
      readonly key: string;
      readonly ordinal: number;
      /**
       * The skeleton's description of the row, or `null` when that ordinal is
       * still a hole. `null` means "a row exists here and nothing about it has
       * arrived yet" - never "no such row", which `rowCount` alone decides.
       */
      readonly entry: RowSkeletonEntry | null;
    };

/** The key a placeholder takes before any skeleton entry describes it. */
export function unplacedRowKey(ordinal: number): string {
  return `unplaced-row:${ordinal}`;
}

/**
 * Merge what the renderer produced with what the window says exists.
 *
 * @param window The transcript window, or `null` on the legacy line - where
 * every row is hydrated by construction and this is the identity mapping.
 * @param rendered `useRenderedMessages` output: hydrated bodies plus the live
 * and pending rows, in display order.
 */
export function transcriptListRows(input: {
  readonly window: TranscriptWindow | null;
  readonly rendered: readonly ChatMessageModel[];
}): readonly TranscriptListRow[] {
  const { window, rendered } = input;
  // The legacy line, and the void window. An invalidated index names ordinals
  // in a coordinate space this client has left, so drawing placeholders from it
  // would put rows in positions that no longer mean anything; the caller owes a
  // `resnapshot` and this renders what it holds until that lands.
  if (window === null || window.invalidated) {
    return rendered.map((model) => ({
      kind: "hydrated",
      key: model.id,
      ordinal: null,
      model,
    }));
  }

  const modelsById = new Map(rendered.map((model) => [model.id, model]));
  const modelByOrdinal = new Map<number, ChatMessageModel>();
  const placedRowIds = new Set<string>();
  for (const span of window.spans) {
    span.rowIds.forEach((rowId, offset) => {
      const ordinal = span.fromOrdinal + offset;
      // A span reaching past `rowCount` would be a host/client disagreement
      // about length. Dropping the row here rather than emitting it beyond the
      // list keeps the list exactly `rowCount` long; the identity echo is what
      // reports the disagreement.
      if (ordinal >= window.rowCount) return;
      const model = modelsById.get(rowId);
      if (model === undefined) return;
      modelByOrdinal.set(ordinal, model);
      placedRowIds.add(rowId);
    });
  }

  const rows: TranscriptListRow[] = [];
  for (let ordinal = 0; ordinal < window.rowCount; ordinal += 1) {
    const model = modelByOrdinal.get(ordinal);
    if (model !== undefined) {
      rows.push({ kind: "hydrated", key: model.id, ordinal, model });
      continue;
    }
    const entry = window.skeleton[ordinal] ?? null;
    rows.push({
      kind: "placeholder",
      key: entry === null ? unplacedRowKey(ordinal) : entry.rowId,
      ordinal,
      entry,
    });
  }
  for (const model of rendered) {
    if (placedRowIds.has(model.id)) continue;
    rows.push({ kind: "hydrated", key: model.id, ordinal: null, model });
  }
  return rows;
}

/**
 * The ordinal span a rendered index range covers, for viewport hydration.
 *
 * Rows without an ordinal (the live tail) contribute nothing: asking to hydrate
 * them is meaningless, and letting them widen the range would request ordinals
 * the viewport is not actually showing. `null` when the visible slice holds no
 * placed row at all, which is what a chat scrolled to its pending tail looks
 * like.
 */
export function visibleOrdinalRange(
  rows: readonly TranscriptListRow[],
  fromIndex: number,
  toIndex: number,
): { readonly fromOrdinal: number; readonly toOrdinal: number } | null {
  let lowest: number | null = null;
  let highest: number | null = null;
  const start = Math.max(0, fromIndex);
  const end = Math.min(rows.length, toIndex);
  for (let index = start; index < end; index += 1) {
    // `number` on a placeholder, `number | null` on a hydrated row - the union
    // narrows to `number | null`, which is exactly the check below.
    const ordinal = rows[index].ordinal;
    if (ordinal === null) continue;
    if (lowest === null || ordinal < lowest) lowest = ordinal;
    if (highest === null || ordinal > highest) highest = ordinal;
  }
  if (lowest === null || highest === null) return null;
  return { fromOrdinal: lowest, toOrdinal: highest + 1 };
}
