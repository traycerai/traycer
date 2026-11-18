import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseHtmlSource,
  readRootCustomProperties,
} from "@traycer/html-source";
import {
  openCanvasLayout,
  readCanvasLayout,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import {
  CANVAS_PROOF_EPIC_ID,
  createCanvasEditingProofFixture,
  createCanvasEditingProofStore,
  type CanvasEditingProofFixture,
} from "../canvas-editing-proof-fixture";
import {
  createCanvasProofFixture,
  type CanvasProofFixture,
} from "../canvas-proof-fixture";

const LABELS = [
  "Welcome",
  "Links",
  "Page error",
  "Theme tweaks",
  "Image swap",
  "Script-changed text",
  "Generated content",
] as const;

const created: { readonly dispose: () => void }[] = [];

function editing(): CanvasEditingProofFixture {
  const fixture = createCanvasEditingProofFixture();
  created.push(fixture);
  return fixture;
}

function original(): CanvasProofFixture {
  const fixture = createCanvasProofFixture();
  created.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of created.splice(0)) fixture.dispose();
});

function layoutOf(fixture: CanvasProofFixture) {
  return readCanvasLayout(
    openCanvasLayout(fixture.binding.doc, fixture.artifact.id),
  );
}

function boardPath(index: number): string {
  return `boards/screen-${index + 1}.html`;
}

async function sourceOf(
  fixture: CanvasProofFixture,
  path: string,
): Promise<string> {
  const entry = fixture.artifact.head?.files[path];
  if (entry === undefined) throw new Error(`no ${path} in the manifest`);
  const answer = await fixture.binding.readSpan(
    entry.sha256,
    0,
    entry.byteLength,
    new AbortController().signal,
  );
  if ("unavailable" in answer) throw new Error(`${path} is unavailable`);
  expect(answer.totalBytes).toBe(entry.byteLength);
  return new TextDecoder().decode(answer.bytes);
}

/** The board as a browser runs it: scripts executed, load fired. */
async function runBoard(html: string) {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    errors.push(error.message);
  });
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole });
  await new Promise<void>((resolve) => {
    dom.window.addEventListener("load", () => resolve());
  });
  return {
    document: dom.window.document,
    errors,
    close: () => dom.window.close(),
  };
}

describe("the editing proof keeps the original proof's canvas", () => {
  it("has the same twelve boards, in the same places, pages and order", () => {
    const wrapped = layoutOf(editing());
    const base = layoutOf(original());

    expect(Object.keys(wrapped.boards)).toHaveLength(12);
    expect(wrapped.order).toEqual(base.order);
    // Each document stamps its own client into the ordering tokens, so compare
    // the pages as a person sees them: which, named what, in what order.
    expect(wrapped.pages.map((page) => [page.id, page.name])).toEqual(
      base.pages.map((page) => [page.id, page.name]),
    );
    for (const path of wrapped.order) {
      const { x, y, w, h, page, is_interactive } = wrapped.boards[path];
      expect({ x, y, w, h, page, is_interactive }).toEqual({
        x: base.boards[path].x,
        y: base.boards[path].y,
        w: base.boards[path].w,
        h: base.boards[path].h,
        page: base.boards[path].page,
        is_interactive: base.boards[path].is_interactive,
      });
    }
  });

  it("keeps the notes, including the image note and its asset", () => {
    const wrapped = editing();
    expect(layoutOf(wrapped).notes).toEqual(layoutOf(original()).notes);
    expect(wrapped.artifact.head?.files["assets/image.svg"]).toBeDefined();
  });

  it("keeps the original artifact's identity and the same set of files", () => {
    const wrapped = editing();
    const base = original();
    expect(wrapped.artifact.id).toBe(base.artifact.id);
    expect(Object.keys(wrapped.artifact.head?.files ?? {}).sort()).toEqual(
      Object.keys(base.artifact.head?.files ?? {}).sort(),
    );
    expect(wrapped.binding.doc).not.toBe(base.binding.doc);
  });
});

describe("the editing proof's labelled boards", () => {
  it("titles the first seven boards for what they demonstrate", () => {
    const layout = layoutOf(editing());
    expect(
      layout.order.slice(0, 7).map((path) => layout.boards[path].title),
    ).toEqual([...LABELS]);
  });

  it("leaves the other five boards' titles as they were", () => {
    const wrapped = layoutOf(editing());
    const base = layoutOf(original());
    for (const path of wrapped.order.slice(7))
      expect(wrapped.boards[path].title).toBe(base.boards[path].title);
  });

  it("keeps only the second board playable, as before", () => {
    const layout = layoutOf(editing());
    expect(
      layout.order.filter(
        (path) => layout.boards[path].is_interactive === true,
      ),
    ).toEqual([boardPath(1)]);
  });

  it("serves every labelled board with a manifest size that matches its bytes", async () => {
    const fixture = editing();
    for (let index = 0; index < LABELS.length; index += 1) {
      const path = boardPath(index);
      const entry = fixture.artifact.head?.files[path];
      expect(entry?.sha256).toHaveLength(64);
      expect(entry?.mediaType).toBe("text/html");
      const text = await sourceOf(fixture, path);
      expect(new TextEncoder().encode(text).length).toBe(entry?.byteLength);
      expect(text.startsWith("<!doctype html>")).toBe(true);
    }
  });

  it("serves the other boards from the original proof, unchanged", async () => {
    const fixture = editing();
    const base = original();
    const unlabelled = Array.from(
      { length: 12 - LABELS.length },
      (_unused, offset) => LABELS.length + offset,
    );
    for (const index of unlabelled)
      expect(await sourceOf(fixture, boardPath(index))).toBe(
        await sourceOf(base, boardPath(index)),
      );
  });

  it("gives each labelled board its own file address", () => {
    const files = editing().artifact.head?.files ?? {};
    const hashes = LABELS.map(
      (_label, index) => files[boardPath(index)].sha256,
    );
    expect(new Set(hashes).size).toBe(LABELS.length);
  });

  it("does not serve a hash it does not hold", async () => {
    const answer = await editing().binding.readSpan(
      "z".repeat(64),
      0,
      10,
      new AbortController().signal,
    );
    expect(answer).toEqual({ unavailable: "missing" });
  });

  it("refuses to serve once the caller has given up", () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = editing();
    const entry = fixture.artifact.head?.files[boardPath(0)];
    if (entry === undefined) throw new Error("no board");
    expect(() =>
      fixture.binding.readSpan(entry.sha256, 0, 10, controller.signal),
    ).toThrow();
  });
});

describe("each labelled board demonstrates what its label says", () => {
  it("Welcome has two editable texts with durable ids", async () => {
    const fixture = editing();
    const parsed = parseHtmlSource(await sourceOf(fixture, boardPath(0)));
    const tids = parsed.elements.flatMap((element) =>
      element.effectiveTid === null ? [] : [element.effectiveTid],
    );
    expect(tids).toEqual(["welcome-title", "welcome-text"]);
  });

  it("Links has a link to another board and a link out", async () => {
    const board = await runBoard(await sourceOf(editing(), boardPath(1)));
    const hrefs = [...board.document.querySelectorAll("a")].map((anchor) =>
      anchor.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "./screen-1.html",
      "https://example.com/canvas-proof",
    ]);
    board.close();
  });

  it("Page error throws an error when it loads", async () => {
    const board = await runBoard(await sourceOf(editing(), boardPath(2)));
    expect(
      board.errors.some((message) =>
        message.includes("Canvas proof: page failed on load"),
      ),
    ).toBe(true);
    board.close();
  });

  it("Theme tweaks exposes its three root custom properties", async () => {
    const result = readRootCustomProperties(
      await sourceOf(editing(), boardPath(3)),
    );
    if (!result.ok) throw new Error("no root rule");
    expect(result.properties.map(({ name, value }) => [name, value])).toEqual([
      ["--accent-color", "#6366f1"],
      ["--sample-spacing", "24px"],
      ["--greeting", '"Hello"'],
    ]);
  });

  it("Theme tweaks uses those properties on the sample", async () => {
    const board = await runBoard(await sourceOf(editing(), boardPath(3)));
    expect(board.document.getElementById("theme-sample")).not.toBeNull();
    expect(board.document.querySelector("style")?.textContent).toContain(
      "var(--accent-color)",
    );
    board.close();
  });

  it("Image swap has an image with a durable id, pointing at the shared asset", async () => {
    const fixture = editing();
    const board = await runBoard(await sourceOf(fixture, boardPath(4)));
    const image = board.document.querySelector("img[data-tid='proof-image']");
    expect(image?.getAttribute("src")).toBe("../assets/image.svg");
    board.close();
  });

  it("Script-changed text says one thing in its source and another once the page runs", async () => {
    const text = await sourceOf(editing(), boardPath(5));
    const source = parseHtmlSource(text).elements.find(
      (element) => element.effectiveTid === "script-text",
    );
    expect(source?.children).toMatchObject([
      { kind: "text", value: "Hello world" },
    ]);

    const board = await runBoard(text);
    expect(board.document.getElementById("live-text")?.textContent).toBe(
      "NEW Hello world",
    );
    board.close();
  });

  it("Generated content has an empty container that the page fills in", async () => {
    const text = await sourceOf(editing(), boardPath(6));
    const source = parseHtmlSource(text).elements;
    expect(
      source.some((element) =>
        element.attrs.some(
          (attr) => attr.name === "id" && attr.value === "generated-text",
        ),
      ),
    ).toBe(false);

    const board = await runBoard(text);
    const generated = board.document.getElementById("generated-text");
    expect(generated?.textContent).toBe(
      "This paragraph was created by the page.",
    );
    expect(generated?.hasAttribute("data-tid")).toBe(false);
    board.close();
  });
});

describe("the editing proof's image asset", () => {
  it("is reached by the board's relative path and served as an SVG", async () => {
    const fixture = editing();
    const relative = new URL(
      "../assets/image.svg",
      "https://proof.test/boards/screen-5.html",
    );
    const manifestPath = relative.pathname.slice(1);
    expect(manifestPath).toBe("assets/image.svg");

    const entry = fixture.artifact.head?.files[manifestPath];
    if (entry === undefined)
      throw new Error("the asset is not in the manifest");
    const answer = await fixture.binding.readSpan(
      entry.sha256,
      0,
      entry.byteLength,
      new AbortController().signal,
    );
    if ("unavailable" in answer) throw new Error("asset unavailable");
    expect(answer.mediaType).toBe("image/svg+xml");
    expect(new TextDecoder().decode(answer.bytes)).toContain("<svg");
  });

  it("is not an outside reference: the board and its asset are in one artifact", () => {
    expect(
      editing().binding.resolveOutsideReference("assets/image.svg"),
    ).toBeNull();
  });
});

describe("the editing proof's isolated epic", () => {
  it("holds the artifact, with the labelled boards' files, under its own epic id", () => {
    const fixture = editing();
    const state = fixture.epic.store.getState();
    expect(state.artifacts.allIds).toEqual([fixture.artifact.id]);
    expect(state.artifacts.byId[fixture.artifact.id]).toBe(fixture.artifact);
    expect(
      fixture.epic.store.getState().artifacts.byId[fixture.artifact.id].head
        ?.files[boardPath(0)],
    ).toBeDefined();
    expect(CANVAS_PROOF_EPIC_ID).toBe("canvas-proof");
  });

  it("is disposed with the fixture", () => {
    const fixture = createCanvasEditingProofFixture();
    const dispose = vi.spyOn(fixture.epic, "dispose");
    fixture.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("createCanvasEditingProofStore", () => {
  it("builds nothing until someone subscribes", () => {
    const store = createCanvasEditingProofStore();
    expect(store.getSnapshot()).toBeNull();
  });

  it("builds the fixture on the first subscribe and tells the subscriber", () => {
    const store = createCanvasEditingProofStore();
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);

    expect(store.getSnapshot()).not.toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("shares one fixture between subscribers", () => {
    const store = createCanvasEditingProofStore();
    const first = store.subscribe(() => undefined);
    const fixture = store.getSnapshot();
    const second = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toBe(fixture);
    first();
    second();
  });

  it("keeps the fixture while any subscriber remains", () => {
    const store = createCanvasEditingProofStore();
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);
    const fixture = store.getSnapshot();
    if (fixture === null) throw new Error("no fixture");
    const dispose = vi.spyOn(fixture, "dispose");

    first();
    expect(dispose).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(fixture);
    second();
  });

  it("disposes the fixture when the last subscriber leaves", () => {
    const store = createCanvasEditingProofStore();
    const unsubscribe = store.subscribe(() => undefined);
    const fixture = store.getSnapshot();
    if (fixture === null) throw new Error("no fixture");
    const dispose = vi.spyOn(fixture, "dispose");

    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toBeNull();
  });

  it("disposes only once however often the last unsubscribe is called", () => {
    const store = createCanvasEditingProofStore();
    const unsubscribe = store.subscribe(() => undefined);
    const fixture = store.getSnapshot();
    if (fixture === null) throw new Error("no fixture");
    const dispose = vi.spyOn(fixture, "dispose");

    unsubscribe();
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("builds a fresh fixture when it is mounted again, not the disposed one", () => {
    const store = createCanvasEditingProofStore();
    const first = store.subscribe(() => undefined);
    const before = store.getSnapshot();
    first();

    const second = store.subscribe(() => undefined);
    const after = store.getSnapshot();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(after?.binding.doc).not.toBe(before?.binding.doc);
    second();
  });

  it("does not notify a subscriber that has already left", () => {
    const store = createCanvasEditingProofStore();
    const staying = vi.fn();
    const leaving = vi.fn();
    const stay = store.subscribe(staying);
    const leave = store.subscribe(leaving);
    leave();
    leaving.mockClear();
    stay();
    store.subscribe(() => undefined)();
    expect(leaving).not.toHaveBeenCalled();
  });
});
