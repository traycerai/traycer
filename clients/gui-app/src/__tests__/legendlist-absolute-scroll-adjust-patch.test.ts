import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
    // false when nothing was held.
    it(`${file} lets a held scroll command be cancelled and settled`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        'cancelPendingScroll: () => {\n      state.mvcpAnchorLock = void 0;\n      if (!state.scheduledWork.has("imperativeScrollReady") && state.pendingScrollToEnd === void 0 && state.scrollingTo === void 0) {\n        return false;\n      }\n      const isInitialScrollInFlight = !!(state.scrollingTo && state.scrollingTo.isInitialScroll);\n      ++imperativeScrollToken;\n      cancelImperativeScroll(state);\n      state.scrollAdjustHandler.commitPendingAdjust(void 0);\n',
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
        "const isInitialScrollInFlight = !!(state.scrollingTo && state.scrollingTo.isInitialScroll);\n      ++imperativeScrollToken;\n      cancelImperativeScroll(state);",
      );
      expect(source).toContain(
        "        clearBootstrapInitialScrollSession(state);\n        finishInitialScroll(ctx, {\n          recalculateItems: true,\n          resolvedOffset: getObservedBootstrapInitialScrollOffset(state)\n        });\n      }\n      return true;",
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
    // except at the end the reader asked for, where anchoring inflates the
    // content for a frame.
    it(`${file} recalculates a settled scroll with MVCP unless it finished at the end`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain(
        "const finishedAtEnd = contentSize < state.scrollLength || distanceFromEnd <= EDGE_POSITION_EPSILON;",
      );
      expect(source).toContain(
        "state.triggerCalculateItemsInView) == null ? void 0 : _b.call(state, { doMVCP: !finishedAtEnd, forceFullItemPositions: true });",
      );
    });

    // The latch records the list's last row by key to tell a moved end from a
    // grown tail.
    it(`${file} exposes the row key at an index in its state`, () => {
      const source = readFileSync(join(packageDir, file), "utf8");
      expect(source).toContain("keyAtIndex: (index) => getId(state, index),");
    });
  }
});
