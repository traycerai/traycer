import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { revealDiffFindMatches } from "@/components/diff/diff-find-navigation";
import type { DiffFindMatch, DiffFindUnit } from "@/lib/diff/diff-find";

const MATCH_ATTR = "data-traycer-diff-find-match";
const ACTIVE_ATTR = "data-traycer-diff-find-active";

let scrollIntoViewSpy: Mock;
let originalScrollIntoView: PropertyDescriptor | undefined;

beforeEach(() => {
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  scrollIntoViewSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoViewSpy;
});

afterEach(() => {
  document.body.replaceChildren();
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  }
});

function createDiffDom() {
  const scrollContainer = document.createElement("div");
  const diffsContainer = document.createElement("diffs-container");
  const shadowRoot = diffsContainer.attachShadow({ mode: "open" });
  const unified = document.createElement("div");
  unified.setAttribute("data-unified", "");
  const deletionSide = document.createElement("div");
  deletionSide.setAttribute("data-deletions", "");
  const additionSide = document.createElement("div");
  additionSide.setAttribute("data-additions", "");
  const deletionRow = document.createElement("code");
  deletionRow.setAttribute("data-line-index", "1,1");
  const additionRow = document.createElement("code");
  additionRow.setAttribute("data-line-index", "2,1");
  const staleRow = document.createElement("code");
  staleRow.setAttribute(MATCH_ATTR, "");
  staleRow.setAttribute(ACTIVE_ATTR, "");

  deletionSide.appendChild(deletionRow);
  additionSide.appendChild(additionRow);
  unified.appendChild(staleRow);
  shadowRoot.append(deletionSide, additionSide, unified);
  scrollContainer.appendChild(diffsContainer);
  document.body.appendChild(scrollContainer);

  return {
    scrollContainer,
    deletionRow,
    additionRow,
    staleRow,
  };
}

function makeRowUnit(args: {
  readonly id: string;
  readonly side: DiffFindUnit["side"];
  readonly unifiedLineIndex: number;
  readonly splitLineIndex: number;
}): DiffFindUnit {
  return {
    id: args.id,
    kind: "row",
    side: args.side,
    filePath: "src/app.ts",
    scopeId: null,
    text: "line",
    hunkIndex: 0,
    unifiedLineIndex: args.unifiedLineIndex,
    splitLineIndex: args.splitLineIndex,
    oldLineNumber: args.side === "deletions" ? 2 : null,
    newLineNumber: args.side === "additions" ? 2 : null,
  };
}

function makeFileUnit(args: {
  readonly id: string;
  readonly filePath: string;
}): DiffFindUnit {
  return {
    id: args.id,
    kind: "file",
    side: "none",
    filePath: args.filePath,
    scopeId: null,
    text: args.filePath,
    hunkIndex: null,
    unifiedLineIndex: null,
    splitLineIndex: null,
    oldLineNumber: null,
    newLineNumber: null,
  };
}

function makeMatch(unit: DiffFindUnit): DiffFindMatch {
  return {
    id: `${unit.id}:0:0`,
    unit,
    start: 0,
    endExclusive: 4,
  };
}

describe("revealDiffFindMatches", () => {
  it("paints all row matches, activates the current row, and scrolls it into view", () => {
    const dom = createDiffDom();
    const deletionMatch = makeMatch(
      makeRowUnit({
        id: "row:deletion",
        side: "deletions",
        unifiedLineIndex: 1,
        splitLineIndex: 1,
      }),
    );
    const additionMatch = makeMatch(
      makeRowUnit({
        id: "row:addition",
        side: "additions",
        unifiedLineIndex: 2,
        splitLineIndex: 1,
      }),
    );

    const exactHighlight = revealDiffFindMatches({
      scrollContainer: dom.scrollContainer,
      matches: [deletionMatch, additionMatch],
      activeMatch: additionMatch,
      scrollActiveIntoView: true,
    });

    expect(exactHighlight).toBe("painted");
    expect(dom.deletionRow.hasAttribute(MATCH_ATTR)).toBe(true);
    expect(dom.deletionRow.hasAttribute(ACTIVE_ATTR)).toBe(false);
    expect(dom.additionRow.hasAttribute(MATCH_ATTR)).toBe(true);
    expect(dom.additionRow.hasAttribute(ACTIVE_ATTR)).toBe(true);
    expect(dom.staleRow.hasAttribute(MATCH_ATTR)).toBe(false);
    expect(dom.staleRow.hasAttribute(ACTIVE_ATTR)).toBe(false);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("paints file-level matches whose paths contain selector syntax", () => {
    const scrollContainer = document.createElement("div");
    const fileElement = document.createElement("section");
    const filePath = 'src/weird"]\\\\\nfile.ts';
    fileElement.setAttribute("data-diff-find-file", filePath);
    scrollContainer.appendChild(fileElement);
    document.body.appendChild(scrollContainer);
    const fileMatch = makeMatch(makeFileUnit({ id: "file:weird", filePath }));

    const exactHighlight = revealDiffFindMatches({
      scrollContainer,
      matches: [fileMatch],
      activeMatch: fileMatch,
      scrollActiveIntoView: true,
    });

    expect(exactHighlight).toBe("painted");
    expect(fileElement.hasAttribute(MATCH_ATTR)).toBe(true);
    expect(fileElement.hasAttribute(ACTIVE_ATTR)).toBe(true);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("returns pending when the active row is not mounted yet", () => {
    const dom = createDiffDom();
    const unmountedMatch = makeMatch(
      makeRowUnit({
        id: "row:unmounted",
        side: "additions",
        unifiedLineIndex: 50,
        splitLineIndex: 50,
      }),
    );

    const exactHighlight = revealDiffFindMatches({
      scrollContainer: dom.scrollContainer,
      matches: [unmountedMatch],
      activeMatch: unmountedMatch,
      scrollActiveIntoView: true,
    });

    expect(exactHighlight).toBe("pending");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("paints the active row but does not scroll when scrollActiveIntoView is false", () => {
    const dom = createDiffDom();
    const additionMatch = makeMatch(
      makeRowUnit({
        id: "row:addition",
        side: "additions",
        unifiedLineIndex: 2,
        splitLineIndex: 1,
      }),
    );

    const exactHighlight = revealDiffFindMatches({
      scrollContainer: dom.scrollContainer,
      matches: [additionMatch],
      activeMatch: additionMatch,
      scrollActiveIntoView: false,
    });

    expect(exactHighlight).toBe("painted");
    expect(dom.additionRow.hasAttribute(MATCH_ATTR)).toBe(true);
    expect(dom.additionRow.hasAttribute(ACTIVE_ATTR)).toBe(true);
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });
});
