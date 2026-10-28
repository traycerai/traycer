import { expect, type Page } from "@playwright/test";
import { nextFrames } from "./fixtures";

/**
 * The checks of `formal/ChatScroll.tla`, read off a live transcript in
 * `src/__tests__/browser/chat-scroll-model.tsx` (its `window.__chatScrollProbe`).
 * Every scenario spec drives the transcript, waits for it to come to rest,
 * and asks the same questions the model asks at rest, so a failing cell here
 * and a model counterexample name the same broken promise.
 */

/** `window.__chatScrollProbe`, as the fixture writes it. Declared here once
 *  for every spec in this project: import this module, do not redeclare it. */
export interface ChatScrollProbe {
  readonly grow: () => void;
  readonly startStream: (intervalMs: number) => void;
  /** Grows the last reply by a whole paragraph each tick. */
  readonly startParagraphStream: (intervalMs: number) => void;
  readonly stopStream: () => void;
  readonly appendTurn: () => void;
  /** A turn whose reply opens with a collapsible reasoning card. */
  readonly appendCardTurn: () => void;
  /** Like `appendCardTurn`, with five paragraphs above the card. */
  readonly appendTallCardTurn: () => void;
  /** Prepends `paragraphs` paragraphs to the first text of a reply; legacy line only. */
  readonly insertAboveInRow: (messageId: string, paragraphs: number) => void;
  readonly hide: (kind: "intact" | "collapse") => void;
  readonly show: () => void;
  /** `true`: the same tab instance mounts again (eviction). `false`: the tab
   *  closes and a new tab opens the chat. */
  readonly remount: (sameInstance: boolean) => void;
  readonly pickItems: () => string[];
  readonly pick: (index: number) => void;
  readonly geometry: () => {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  } | null;
  readonly mode: () => string | null;
  readonly pillShown: () => boolean;
  readonly rowTop: (messageId: string) => number | null;
  readonly readingRow: () => {
    readonly messageId: string | null;
    readonly offset: number;
    /** A cold row's placeholder; always `false` on the legacy line. */
    readonly placeholder: boolean;
  } | null;
  /** The saved reading position for this tab instance. */
  readonly saved: () => {
    readonly mode: string;
    readonly anchorMessageId: string | null;
    readonly offset: number;
  } | null;
  readonly instanceId: () => string;

  // Both lines. `?line=windowed` opens production's windowed line, where
  // `rowTop` and `readingRow` answer for a cold row with its placeholder.
  readonly line: () => "legacy" | "windowed";
  /** `true` a placeholder, `false` hydrated, `null` not mounted. */
  readonly isPlaceholder: (messageId: string) => boolean | null;
  /** Hydrated spans as `[fromOrdinal, toOrdinal)`; `null` on the legacy line. */
  readonly hydratedRange: () => ChatScrollHydration | null;
  /** The row's ordinal in the host's index; `null` on the legacy line. */
  readonly ordinalOf: (messageId: string) => number | null;
  /** The session store's `transcriptWindow`; `null` on the legacy line. */
  readonly windowState: () => ChatScrollWindowState | null;
  /** Host frames and client requests, timestamped; empty on the legacy line. */
  readonly frameLog: () => string[];

  // Windowed line only: each throws on the legacy line.
  /** How long the host takes to answer a range (default 120ms). */
  readonly setHydrationLatency: (ms: number) => void;
  /** Production's memory-pressure eviction: every span the viewport does not
   *  protect goes back to placeholders. */
  readonly evictCold: () => void;
  /** The draft grows to this many lines, and the composer dock with it
   *  (130px at one line, 173px at eight). */
  readonly typeDraft: (lines: number) => void;
  /** The person sends: the store's own send, and the dock returns to one
   *  line a frame later. Returns the message id. */
  readonly send: (text: string) => string;
  /** The host acks, accepts and appends the oldest send, then starts its turn. */
  readonly hostAccept: () => void;
  /** The host writes the running turn's assistant record, with what has
   *  streamed so far. A stream before it reaches only the live reply. */
  readonly assistantStarts: () => void;
  /** The host completes the running turn. */
  readonly finishTurn: () => void;
}

export interface ChatScrollHydration {
  readonly rowCount: number;
  readonly spans: ReadonlyArray<{
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
  }>;
  readonly liveMessageIds: ReadonlyArray<string>;
}

export interface ChatScrollWindowState extends ChatScrollHydration {
  readonly epoch: number;
  readonly indexRevision: number;
  readonly skeletonLength: number;
  readonly skeletonComplete: boolean;
  readonly skeletonStreamCoveredThrough: number;
  readonly invalidated: boolean;
  readonly staleSpans: ReadonlyArray<{
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
  }>;
  readonly pendingUserMessageIds: ReadonlyArray<string>;
  readonly activeTurnId: string | null;
  readonly runStatus: string;
}

declare global {
  interface Window {
    __chatScrollProbe: ChatScrollProbe;
    /** Written by `startTimeline`. */
    __chatScrollTimelineStop?: () => string;
  }
}

/** Distance from the bottom that still counts as the strict bottom, as the
 *  follow latch's 1px epsilon does. */
export const STRICT_BOTTOM_PX = 1;
/** `CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX`: a picked turn lands this far
 *  below the top of the viewport. */
export const PICK_OFFSET_PX = 48;
/** Slack for a row that should not have moved: subpixel layout only. */
const HELD_PX = 2;

/** What the reader last asked the transcript to show: the model's ghost
 *  `intent`. */
export type ReaderIntent =
  | { readonly kind: "tail" }
  /** The reader scrolled here: this row's top sat `offset` px below the top
   *  of the viewport (negative when the row starts above it). */
  | { readonly kind: "at"; readonly messageId: string; readonly offset: number }
  /** The reader picked this turn (minimap, Messages list). */
  | { readonly kind: "picked"; readonly messageId: string };

export interface ChatScrollView {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly fromEnd: number;
  /** `following-end` | `free-scrolling` */
  readonly mode: string | null;
  readonly pill: boolean;
  /** The first row the top of the viewport crosses, and its top offset. */
  readonly reading: {
    readonly messageId: string | null;
    readonly offset: number;
  } | null;
}

export async function readView(page: Page): Promise<ChatScrollView> {
  const view = await page.evaluate(() => {
    const probe = window.__chatScrollProbe;
    const geometry = probe.geometry();
    if (geometry === null) return null;
    return {
      ...geometry,
      fromEnd:
        geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop,
      mode: probe.mode(),
      pill: probe.pillShown(),
      reading: probe.readingRow(),
    };
  });
  if (view === null) throw new Error("no transcript scroll node");
  return view;
}

/**
 * Waits until the transcript is at rest: scrollTop, scrollHeight and the mode
 * unchanged for `stillFrames` consecutive frames (a pending end correction
 * bursts over five two-frame windows, a deferred list command waits up to
 * 800ms). Stop any stream first; a streaming transcript never rests.
 */
export async function settle(
  page: Page,
  stillFrames: number,
): Promise<ChatScrollView> {
  let previous = await readView(page);
  let still = 0;
  for (let i = 0; i < 400 && still < stillFrames; i += 1) {
    await nextFrames(page, 1);
    const current = await readView(page);
    const same =
      current.scrollTop === previous.scrollTop &&
      current.scrollHeight === previous.scrollHeight &&
      current.mode === previous.mode &&
      current.pill === previous.pill;
    still = same ? still + 1 : 0;
    previous = current;
  }
  return previous;
}

/** The reader's intent for the view they are looking at now. */
export function intentOf(view: ChatScrollView): ReaderIntent {
  const reading = view.reading;
  if (
    view.fromEnd <= STRICT_BOTTOM_PX ||
    reading === null ||
    reading.messageId === null
  ) {
    return { kind: "tail" };
  }
  return { kind: "at", messageId: reading.messageId, offset: reading.offset };
}

function describe(view: ChatScrollView): string {
  const reading =
    view.reading === null
      ? "none"
      : `${String(view.reading.messageId)}@${view.reading.offset.toFixed(1)}`;
  return (
    `scrollTop=${view.scrollTop.toFixed(1)} fromEnd=${view.fromEnd.toFixed(1)} ` +
    `scrollHeight=${String(view.scrollHeight)} clientHeight=${String(view.clientHeight)} ` +
    `mode=${String(view.mode)} pill=${String(view.pill)} reading=${reading}`
  );
}

/**
 * The model's at-rest checks: I_IntentHeld, I_ModeMatchesGeometry and
 * I_PillHonest. Settles first, then reports every broken one at once, with
 * the view, under `label` (the scenario step).
 */
export async function expectAtRest(
  page: Page,
  intent: ReaderIntent,
  label: string,
): Promise<ChatScrollView> {
  const view = await settle(page, 12);
  const atBottom = view.fromEnd <= STRICT_BOTTOM_PX;
  const broken: string[] = [];

  if (intent.kind === "tail") {
    if (!atBottom) broken.push("I_IntentHeld: the reader asked for the tail");
  } else {
    const rowTop = await page.evaluate(
      (id) => window.__chatScrollProbe.rowTop(id),
      intent.messageId,
    );
    const wanted = intent.kind === "at" ? intent.offset : PICK_OFFSET_PX;
    // A row in the last screenful cannot rise to its offset, and one in the
    // first cannot drop to it: the bottom, or the top, is where it lands.
    const unreachable =
      rowTop !== null &&
      ((atBottom && rowTop > wanted) ||
        (view.scrollTop <= 0 && rowTop < wanted));
    if (rowTop === null) {
      broken.push(
        `I_IntentHeld: ${intent.messageId} is not mounted (wanted it at ${String(wanted)})`,
      );
    } else if (Math.abs(rowTop - wanted) > HELD_PX && !unreachable) {
      broken.push(
        `I_IntentHeld: ${intent.messageId} is at ${rowTop.toFixed(1)}, the reader left it at ${wanted.toFixed(1)}`,
      );
    }
  }
  if ((view.mode === "following-end") !== atBottom) {
    broken.push(
      `I_ModeMatchesGeometry: mode=${String(view.mode)} ${atBottom ? "at" : "away from"} the bottom`,
    );
  }
  if (view.pill === atBottom) {
    broken.push(
      `I_PillHonest: pill=${String(view.pill)} ${atBottom ? "at" : "away from"} the bottom`,
    );
  }

  expect(
    broken,
    `${label}\n  ${describe(view)}\n  ${broken.join("\n  ")}`,
  ).toEqual([]);
  return view;
}

/**
 * I_SavedIsView end to end: after a hide/show or a remount, the reader is
 * back where they were (`before` is the view from rest before it). Checks the
 * at-rest invariants against that intent.
 */
export async function expectPositionKept(
  page: Page,
  before: ChatScrollView,
  label: string,
): Promise<ChatScrollView> {
  return expectAtRest(page, intentOf(before), `${label} (position kept)`);
}

/**
 * Records one reading per painted frame until the returned stop function is
 * called, for a failure message that shows how the view got where it is.
 */
export async function startTimeline(
  page: Page,
): Promise<() => Promise<string>> {
  await page.evaluate(() => {
    const rows: string[] = [];
    const startedAt = performance.now();
    let running = true;
    const tick = (): void => {
      if (!running) return;
      const probe = window.__chatScrollProbe;
      const g = probe.geometry();
      if (g !== null) {
        const fromEnd = g.scrollHeight - g.clientHeight - g.scrollTop;
        const reading = probe.readingRow();
        const line =
          `${(performance.now() - startedAt).toFixed(0)}ms top=${g.scrollTop.toFixed(0)} ` +
          `h=${String(g.scrollHeight)} fromEnd=${fromEnd.toFixed(0)} ${String(probe.mode())} ` +
          `pill=${String(probe.pillShown())} reading=${String(reading?.messageId)}@${(reading?.offset ?? 0).toFixed(0)}`;
        if (
          rows.at(-1)?.slice(rows.at(-1)?.indexOf(" ") ?? 0) !==
          line.slice(line.indexOf(" "))
        ) {
          rows.push(line);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__chatScrollTimelineStop = () => {
      running = false;
      return rows.join("\n");
    };
  });
  return () => page.evaluate(() => window.__chatScrollTimelineStop?.() ?? "");
}
