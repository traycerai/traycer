import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * `patches/@legendapp%2Flist@<version>.patch` makes the web build's scroll
 * adjustments absolute writes. iOS WebKit applies a relative `scrollBy` twice
 * (the synchronous move, then the same delta again on the next scroll event),
 * so every `maintainVisibleContentPosition` compensation issued while a row
 * above the viewport is measured during a touch fling landed doubled, and the
 * library re-requested it: a flick through the chat transcript on the phone
 * bounced by whole screens. An absolute `scrollTo` lands once on every engine.
 *
 * `patchedDependencies` is keyed by the exact package version, so a bump of
 * the list silently drops the patch. This reads the installed web build, not
 * the patch file, so what it certifies is the code the renderer loads.
 */

interface SizedItem {
  type: string;
}

interface AverageEntry {
  avg: number;
  num: number;
}

/**
 * `updateOneItemSize` of the installed build, evaluated on its own: it is not
 * exported, and the two helpers it calls (`getItemSize`, `setSize`) are
 * stubbed, so what runs is the build's own averaging. The list state is a
 * proxy that answers a field the build adds to it (the patch records which
 * type each key's measurement is averaged under) with an empty map, as the
 * list's state creation does.
 */
function loadUpdateOneItemSize(
  source: string,
): (
  ctx: unknown,
  itemKey: string,
  sizeObj: { height: number; width: number },
  resolvedMeasurementItem: undefined,
) => unknown {
  const start = source.indexOf("function updateOneItemSize(");
  const end = source.indexOf("\n}\n", start);
  if (start === -1 || end === -1) {
    throw new Error("updateOneItemSize is not in the installed build");
  }
  const body = source.slice(start, end + 2);
  const factory: unknown = runInNewContext(
    `(function (getItemSize, setSize) { ${body}\n return updateOneItemSize; })`,
    {},
  );
  if (typeof factory !== "function") throw new Error("no factory");
  const updateOneItemSize: unknown = Reflect.apply(factory, undefined, [
    () => 0,
    () => undefined,
  ]);
  if (typeof updateOneItemSize !== "function") {
    throw new Error("no updateOneItemSize");
  }
  return (ctx, itemKey, sizeObj, resolvedMeasurementItem) => {
    const result: unknown = Reflect.apply(updateOneItemSize, undefined, [
      ctx,
      itemKey,
      sizeObj,
      resolvedMeasurementItem,
    ]);
    return result;
  };
}

interface AnnouncedMove {
  readonly from: number;
  readonly fromEnd: number;
  readonly to: number;
  readonly intended: number;
}

interface ClampingScroller {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  dispatchEvent: (event: CustomEvent<AnnouncedMove>) => boolean;
}

/**
 * A scroll node whose `scrollTop` jsdom does not clamp on its own: reading it
 * back clamps to the live range, as a real scroller's does the instant a
 * write (the test's own `write`, standing in for the pad restore) shrinks
 * `scrollHeight` out from under the stored offset.
 *
 * The clamp sticks, as the browser's does: it moves the offset the scroller
 * holds, so growing the range afterwards leaves the view where the clamp put
 * it rather than springing it back. The whole defect this patch fixes lives
 * on that: the restore's clamp and a commit that regrows the end land in one
 * frame, and the view stays down at the clamp while the end goes back up.
 */
function makeClampingScroller(initial: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): { scroller: ClampingScroller; announcements: AnnouncedMove[] } {
  let storedScrollTop = initial.scrollTop;
  const announcements: AnnouncedMove[] = [];
  const scroller: ClampingScroller = {
    scrollHeight: initial.scrollHeight,
    clientHeight: initial.clientHeight,
    get scrollTop(): number {
      storedScrollTop = Math.max(
        0,
        Math.min(
          storedScrollTop,
          scroller.scrollHeight - scroller.clientHeight,
        ),
      );
      return storedScrollTop;
    },
    set scrollTop(value: number) {
      storedScrollTop = value;
    },
    dispatchEvent(event: CustomEvent<AnnouncedMove>): boolean {
      announcements.push(event.detail);
      return true;
    },
  };
  return { scroller, announcements };
}

/**
 * `moveScrollerByRangeAnnounced` of the installed build, evaluated on its
 * own along with the two helpers it calls (`announcesScrollerMoves`,
 * `announceScrollerMove`) and the unrelated `moveScrollerAnnounced` the same
 * slice carries - the function is not exported, so there is nothing to
 * import. A bare vm context defines no DOM globals, so `CustomEvent` is
 * supplied as a factory argument; `window` is left undefined, which is what
 * lets `announcesScrollerMoves` see the fake scroller as "not window", as it
 * would in a browser.
 */
function loadMoveScrollerByRangeAnnounced(
  source: string,
): (target: ClampingScroller, write: () => void) => void {
  const start = source.indexOf("function announcesScrollerMoves(");
  const end = source.indexOf("function scrollAdjustBy(", start);
  if (start === -1 || end === -1) {
    throw new Error(
      "the announced-move helpers are not in the installed build",
    );
  }
  const body = source.slice(start, end);
  const factory: unknown = runInNewContext(
    `(function (CustomEvent) { ${body}\n return moveScrollerByRangeAnnounced; })`,
    {},
  );
  if (typeof factory !== "function") throw new Error("no factory");
  const moveScrollerByRangeAnnounced: unknown = Reflect.apply(
    factory,
    undefined,
    [CustomEvent],
  );
  if (typeof moveScrollerByRangeAnnounced !== "function") {
    throw new Error("no moveScrollerByRangeAnnounced");
  }
  return (target, write) => {
    Reflect.apply(moveScrollerByRangeAnnounced, undefined, [target, write]);
  };
}

/** A list of two rows, `a` and `k`, whose `k` changes item type as the chat's
 *  transcript does when a placeholder hydrates. */
function twoRowList() {
  const data: SizedItem[] = [{ type: "assistant" }, { type: "assistant" }];
  const averageSizes: Partial<Record<string, AverageEntry>> = {};
  const state = {
    indexByKey: new Map([
      ["a", 0],
      ["k", 1],
    ]),
    sizesKnown: new Map<string, number>(),
    averageSizes,
    props: {
      data,
      horizontal: false,
      getItemType: (item: SizedItem) => item.type,
      getFixedItemSize: undefined,
    },
  };
  const extra = new Map<PropertyKey, unknown>();
  const proxy = new Proxy(state, {
    get(target, property) {
      if (property in target) {
        const present: unknown = Reflect.get(target, property);
        return present;
      }
      let value = extra.get(property);
      if (value === undefined) {
        value = new Map();
        extra.set(property, value);
      }
      return value;
    },
  });
  return { ctx: { state: proxy }, data, averageSizes };
}

describe("@legendapp/list web patch", () => {
  const require = createRequire(import.meta.url);
  // The package's `exports` map hides `package.json` and has no main entry;
  // every entry point sits in the package root, so a subpath's directory is
  // that root.
  const packageDir = dirname(require.resolve("@legendapp/list/react"));

  // `react.*` is the `@legendapp/list/react` entry the chat timeline imports;
  // the `react-native.web.*` pair carries the same code for the other entry.
  for (const file of [
    "react.js",
    "react.mjs",
    "react-native.web.js",
    "react-native.web.mjs",
  ]) {
    it(`${file} writes the scroll adjustment as an absolute offset`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        'el.scrollTo({ behavior: "auto", left: el.scrollLeft + left, top: el.scrollTop + top });',
      );
      expect(source).not.toContain(
        'el.scrollBy({ behavior: "auto", left, top });',
      );
      expect(source).not.toContain(
        'target.scrollBy({ behavior: "auto", left: x, top: y });',
      );
    });

    // The chat restores a saved row with `viewPosition: 0`, its top at the
    // viewport's top. Unpatched, any defined `viewPosition` on the last row
    // added the footer's height, so each restore of a reading position on the
    // last turn landed one footer lower than saved, and every remount moved
    // it again.
    it(`${file} adds the footer only when the last row aligns below the top`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "if (!isOutOfBounds && index === state.props.data.length - 1 && viewPosition > 0) {",
      );
      expect(source).not.toContain(
        "if (!isOutOfBounds && index === state.props.data.length - 1) {",
      );
    });

    // Unpatched, a re-measured row cut by the viewport's top edge moved the
    // view by all of its growth: a card opened in a reply read from its middle
    // threw its own header off screen, and a narrower window drifted the
    // reading row. The patch holds the element at that edge instead.
    it(`${file} anchors a re-measured row at the element on the top edge`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "updateScroll(ctx, newScroll, insetChanged, { fromNativeScrollEvent: true });\n  recordEdgeAnchor(ctx);",
      );
      expect(source).toContain("positionDiff += edgeAnchorShift;");
    });

    // The anchor looks for the element on the viewport's top edge inside the
    // row. Markdown and component wrappers are `display: contents` and have no
    // box, so the search stopped at the row's content wrapper and missed the
    // element the reader was looking at; a re-measured row then drifted by
    // whole lines. A child with no box is searched in its children's stead.
    it(`${file} searches through a child with no box for the edge element`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain("function findEdgeChild(parent, edgeY) {");
      expect(source).toContain(
        "if (rect.height === 0) {\n      const inner = findEdgeChild(child, edgeY);",
      );
      expect(source).toContain("const next = findEdgeChild(node, edgeY);");
    });

    // A renderer that reuses an element for other content (blocks inserted
    // above it, keyed by position) leaves a node whose movement says nothing
    // about the reader's text, so the anchor remembers what the node held.
    it(`${file} records what the anchored element held`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain("head: edgeAnchorHead(node)\n  };");
    });

    // The anchor is recorded on every scroll event, and the element on the
    // edge can be a whole code block: reading its `textContent` built the
    // block's entire text each frame to keep 64 characters of it. The head
    // walks the text nodes and stops once it has them.
    it(`${file} reads only the head of the anchored element's text`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        'const walker = node.ownerDocument.createTreeWalker(node, 4 | 8);\n  let head = "";\n  for (let part = walker.nextNode(); part !== null && head.length < 64; part = walker.nextNode()) {\n    head += part.data;\n  }\n  return head.slice(0, 64);',
      );
      expect(source).not.toContain("const text = node.textContent;");
    });

    // ...and the list's own anchor decides once the element holds other text.
    it(`${file} gives up an anchor whose element now holds other content`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "edgeAnchorHead(anchor.node) !== anchor.head) {\n    return void 0;",
      );
    });

    // The chat cancels a restore's or navigation's command the list still
    // holds when the reader scrolls: left alone, it lands after the reader's
    // own scroll and undoes it. The cancel also drops the data change's anchor
    // lock and lets the adjusts a scroll in flight deferred land, and reports
    // false when nothing was held. It keeps the runner later `scrollToEnd`
    // commands need: the unmount's cancel drops it, and without it every
    // later one never ran.
    it(`${file} lets a held scroll command be cancelled and settled`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        'cancelPendingScroll: () => {\n      state.mvcpAnchorLock = void 0;\n      if (!state.scheduledWork.has("imperativeScrollReady") && state.pendingScrollToEnd === void 0 && state.scrollingTo === void 0) {\n        return false;\n      }\n      const isInitialScrollInFlight = !!(state.scrollingTo && state.scrollingTo.isInitialScroll);\n      ++imperativeScrollToken;\n      const runPendingScrollToEnd = state.runPendingScrollToEnd;\n      cancelImperativeScroll(state);\n      state.runPendingScrollToEnd = runPendingScrollToEnd;\n      state.scrollAdjustHandler.commitPendingAdjust(void 0);\n',
      );
      expect(source).toContain(
        "      return true;\n    },\n    setScrollProcessingEnabled:",
      );
    });

    // A restore's first-paint scroll the list has issued and not finished is
    // held in `scrollingTo` with `isInitialScroll`. Cancelling it for the
    // reader's gesture used to clear that, so the next measurement re-issued
    // the first-paint scroll over the reader and the list withheld its scroll
    // reports until it finished: hiding then saved the restored row, not the
    // one the reader had scrolled to. The cancel finishes the initial scroll
    // at the observed offset instead; one not yet issued is left alone.
    it(`${file} finishes an in-flight first-paint scroll where the reader is when it is cancelled`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "const isInitialScrollInFlight = !!(state.scrollingTo && state.scrollingTo.isInitialScroll);\n      ++imperativeScrollToken;\n      const runPendingScrollToEnd = state.runPendingScrollToEnd;\n      cancelImperativeScroll(state);\n      state.runPendingScrollToEnd = runPendingScrollToEnd;",
      );
      expect(source).toContain(
        "        clearBootstrapInitialScrollSession(state);\n        finishInitialScroll(ctx, {\n          recalculateItems: true,\n          resolvedOffset: getObservedBootstrapInitialScrollOffset(state)\n        });\n      }\n      return true;",
      );
    });

    // The end pad's rAF restore shrinks the scroll range it grew, and the
    // browser clamps the view down with it in the same layout the restore's
    // own forced read lands in. Left unannounced, that clamp reads to the
    // chat's follow latch as the reader scrolling up. The announced helper is
    // what makes it land through the same channel as every other write of the
    // list's.
    it(`${file} announces a write that clamps the view, and nothing for a write that leaves it reachable`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      const moveScrollerByRangeAnnounced =
        loadMoveScrollerByRangeAnnounced(source);

      // The range shrinks under the view: the browser clamps the stored 1000
      // down to the new end, 900, and that clamp is announced.
      const shrinks = makeClampingScroller({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      moveScrollerByRangeAnnounced(shrinks.scroller, () => {
        shrinks.scroller.scrollHeight = 1400;
      });
      expect(shrinks.announcements).toEqual([
        { from: 1000, fromEnd: 1000, to: 900, intended: 900 },
      ]);

      // The frame the defect lives in: a commit regrows the end right after
      // the clamp. The view stays where the clamp left it, so the offset the
      // announcement carried is still the reader's - and the regrowth, moving
      // no view, announces nothing of its own.
      shrinks.scroller.scrollHeight = 1450;
      expect(shrinks.scroller.scrollTop).toBe(900);
      expect(shrinks.announcements).toHaveLength(1);

      // The common restore: the range shrinks by as much, but the content has
      // grown past the view since the pad went up, so the end stays above it
      // and the view never moves. Nothing is announced.
      const staysReachable = makeClampingScroller({
        scrollTop: 500,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      moveScrollerByRangeAnnounced(staysReachable.scroller, () => {
        staysReachable.scroller.scrollHeight = 1400;
      });
      expect(staysReachable.announcements).toEqual([]);
    });

    // The restore cannot be sliced out of the build on its own (it closes
    // over `resetPaddingRafRef`/`contentNode`/`axis`), so this pins the call
    // site instead: the restore's write goes through the announced helper,
    // forces the same layout read the pad's own growth does, and the bare
    // unannounced assignment the patch replaced is gone.
    it(`${file} routes the pad restore through the announced write, forcing the clamp into this frame`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "moveScrollerByRangeAnnounced(el, () => {\n                contentNode.style[axis.paddingEndProp] = previousPaddingEnd;",
      );
      expect(source).toContain(
        "void contentNode.offsetHeight;\n              });\n            });",
      );
      expect(source).not.toContain(
        "contentNode.style[axis.paddingEndProp] = previousPaddingEnd;\n            });",
      );
    });

    // While an animated scroll runs, the list defers the visible-content
    // adjusts into `pendingAdjust`. A new command replaces the one the list
    // holds, and nothing committed them: the new end target was then computed
    // from positions the screen had not taken, and landed short.
    it(`${file} commits the adjusts a replaced scroll command deferred`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "const startImperativeScroll = (resolve) => {\n    // Patched: a new command replaces the one the list holds.",
      );
      expect(source).toContain(
        'if (state.scrollingTo !== void 0) {\n      state.scrollAdjustHandler.commitPendingAdjust(void 0);\n    }\n    state.scheduledWork.cancel("imperativeScrollReady");\n    const token = ++imperativeScrollToken;',
      );
    });

    // A finished scroll re-estimates every unmeasured row, which can move the
    // rows above the view by tens of thousands of pixels after a long jump.
    // Anchoring that re-layout keeps the rows the scroll left on screen there,
    // except at the end, where anchoring inflates the content for a frame.
    // `react.*` alone holds the estimates above the view in that pass, and
    // releases them only after the initial scroll to the end.
    it(`${file} recalculates a settled scroll with MVCP unless it finished at the end`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "const finishedAtEnd = contentSize < state.scrollLength || distanceFromEnd <= EDGE_POSITION_EPSILON;",
      );
      expect(source).toContain(
        file.startsWith("react.")
          ? "state.triggerCalculateItemsInView) == null ? void 0 : _b.call(state, { doMVCP: !finishedAtEnd, forceFullItemPositions: true, refreshEstimatesAtEnd: finishedAtEnd && !!initialScrollToEnd && liveAtEnd });"
          : "state.triggerCalculateItemsInView) == null ? void 0 : _b.call(state, { doMVCP: !finishedAtEnd, forceFullItemPositions: true });",
      );
    });

    // The latch records the list's last row by key to tell a moved end from a
    // grown tail.
    it(`${file} exposes the row key at an index in its state`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain("keyAtIndex: (index) => getId(state, index),");
    });

    // A placeholder row and the hydrated row that replaces it share a key and
    // differ in item type. The list averaged the hydrated measurement against
    // the placeholder's, in a type that never counted the key: measuring `k`
    // as a 700px placeholder and then as a 100px row, with one 100px row in
    // the type, left an average of -500, and every evict-and-rehydrate cycle
    // took another turn's height off. Unmeasured rows of that type were then
    // placed at negative sizes, over the rows on screen.
    it(`${file} counts a key's size once, under the item type it was measured as`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      const updateOneItemSize = loadUpdateOneItemSize(source);
      const { ctx, data, averageSizes } = twoRowList();
      const measure = (key: string, height: number) =>
        updateOneItemSize(ctx, key, { height, width: 0 }, undefined);

      measure("a", 100);
      expect(averageSizes.assistant).toMatchObject({ avg: 100, num: 1 });

      for (let cycle = 0; cycle < 3; cycle += 1) {
        data[1].type = "placeholder:assistant";
        measure("k", 700);
        data[1].type = "assistant";
        measure("k", 100);
        expect(averageSizes.assistant).toMatchObject({ avg: 100, num: 2 });
        expect(averageSizes["placeholder:assistant"]?.num ?? 0).toBe(0);
      }
    });
  }
});
