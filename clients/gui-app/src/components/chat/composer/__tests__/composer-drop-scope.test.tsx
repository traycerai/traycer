/**
 * A pane that is one drop zone for the message box inside it, through the real
 * `useComposerHashPaste`: the box's own drag handlers decide what is accepted
 * and what a drop delivers, the pane only widens where the gesture is taken.
 * The editor is a handle that records the image attachments it is given.
 */
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  REFUSING_DROP_ZONE_PROPS,
  useComposerDropScope,
  useComposerDropScopeTarget,
} from "@/components/chat/composer/composer-drop-scope";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { ComposerDropOverlay } from "@/components/home/composer/composer-shell";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import {
  useComposerHashPaste,
  type ComposerPasteEditorHandle,
} from "@/hooks/composer/use-composer-paste";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  fileTransfer,
  perform,
  uriOnlyTransfer,
} from "@/lib/composer/__tests__/file-drop-fixtures";

const OVERLAY_TITLE = FILE_DROP_OVERLAY_CONTENT.images.title;

const inserted: ImageAttachmentAttrs[] = [];
const outerInserted: ImageAttachmentAttrs[] = [];

/** A file drag whose `dropEffect` the module under test can write, as a browser's is. */
function writableImageTransfer() {
  return { ...imageTransfer(), dropEffect: "move" };
}

function textTransfer() {
  return {
    files: [],
    types: ["text/plain"],
    items: [],
    getData: () => "",
    dropEffect: "move",
  };
}

function pngFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function imageTransfer() {
  return fileTransfer([pngFile("shot.png")]);
}

// Stable across renders, as the composer's own are.
const PASTE_OPTIONS = {
  fileDrops: {
    resolveDroppedFilePaths: () => Promise.resolve([]),
    copyDroppedFilePaths: (paths: ReadonlyArray<string>) =>
      Promise.resolve([...paths]),
    readNativeClipboardFilePaths: () => Promise.resolve([]),
  },
  mentionRoots: [],
  fileRoute: null,
  pathsReachTarget: true,
} as const;

function ComposerBox(props: { readonly sink: ImageAttachmentAttrs[] }) {
  const { sink } = props;
  const editorRef = useRef<ComposerPasteEditorHandle | null>({
    isReady: () => true,
    insertImageAttachments: (attrs) => {
      sink.push(...attrs);
    },
    insertFileAttachment: () => false,
    settleFileAttachment: () => false,
    beginPathInsertion: () => null,
    focus: () => undefined,
    getJSON: () => ({ type: "doc", content: [] }),
    getEditorIncarnation: () => null,
    draftGeneration: () => 0,
  });
  const paste = useComposerHashPaste(editorRef, PASTE_OPTIONS);
  const frame = useComposerDropScopeTarget({
    onDragEnter: paste.onDragEnter,
    onDragLeave: paste.onDragLeave,
    onDragOver: paste.onDragOver,
    onDrop: paste.onDrop,
    overlayVariant: paste.dragOverlayVariant,
  });
  const { overlayVariant, ...handlers } = frame;
  return (
    <div data-testid="box-frame" className="relative" {...handlers}>
      <div data-testid="box-editor" />
      {overlayVariant === null ? null : (
        <ComposerDropOverlay {...FILE_DROP_OVERLAY_CONTENT[overlayVariant]} />
      )}
    </div>
  );
}

// A box whose handlers are new on every render. A render past the cap throws,
// so a loop between the box and its pane fails the test instead of hanging it.
const RENDER_CAP = 30;
const freshBoxRenders = { count: 0 };

function noteFreshBoxRender(): void {
  freshBoxRenders.count += 1;
  if (freshBoxRenders.count > RENDER_CAP) {
    throw new Error("the box and its pane keep re-rendering each other");
  }
}

function FreshHandlersBox() {
  noteFreshBoxRender();
  const editorRef = useRef<ComposerPasteEditorHandle | null>({
    isReady: () => true,
    insertImageAttachments: (attrs) => {
      inserted.push(...attrs);
    },
    insertFileAttachment: () => false,
    settleFileAttachment: () => false,
    beginPathInsertion: () => null,
    focus: () => undefined,
    getJSON: () => ({ type: "doc", content: [] }),
    getEditorIncarnation: () => null,
    draftGeneration: () => 0,
  });
  const paste = useComposerHashPaste(editorRef, PASTE_OPTIONS);
  const frame = useComposerDropScopeTarget({
    onDragEnter: (event) => paste.onDragEnter(event),
    onDragLeave: (event) => paste.onDragLeave(event),
    onDragOver: (event) => paste.onDragOver(event),
    onDrop: (event) => paste.onDrop(event),
    overlayVariant: paste.dragOverlayVariant,
  });
  const { overlayVariant, ...handlers } = frame;
  return (
    <div data-testid="box-frame" className="relative" {...handlers}>
      {overlayVariant === null ? null : (
        <ComposerDropOverlay {...FILE_DROP_OVERLAY_CONTENT[overlayVariant]} />
      )}
    </div>
  );
}

const sinkA: ImageAttachmentAttrs[] = [];
const sinkB: ImageAttachmentAttrs[] = [];

function editorHandleInto(
  sink: ImageAttachmentAttrs[],
): ComposerPasteEditorHandle {
  return {
    isReady: () => true,
    insertImageAttachments: (attrs) => {
      sink.push(...attrs);
    },
    insertFileAttachment: () => false,
    settleFileAttachment: () => false,
    beginPathInsertion: () => null,
    focus: () => undefined,
    getJSON: () => ({ type: "doc", content: [] }),
    getEditorIncarnation: () => null,
    draftGeneration: () => 0,
  };
}

// Two editors behind two real paste hooks, and the box hands the scope the
// handlers of whichever one is chosen, the way a box's handlers follow its props.
function ChoosingBox(props: { readonly chosen: "a" | "b" }) {
  const refA = useRef<ComposerPasteEditorHandle | null>(
    editorHandleInto(sinkA),
  );
  const refB = useRef<ComposerPasteEditorHandle | null>(
    editorHandleInto(sinkB),
  );
  const pasteA = useComposerHashPaste(refA, PASTE_OPTIONS);
  const pasteB = useComposerHashPaste(refB, PASTE_OPTIONS);
  const paste = props.chosen === "a" ? pasteA : pasteB;
  useComposerDropScopeTarget({
    onDragEnter: paste.onDragEnter,
    onDragLeave: paste.onDragLeave,
    onDragOver: paste.onDragOver,
    onDrop: paste.onDrop,
    overlayVariant: paste.dragOverlayVariant,
  });
  return null;
}

function ChoosingPane(props: { readonly chosen: "a" | "b" }) {
  const scope = useComposerDropScope();
  return (
    <div data-testid="pane" className="relative" {...scope.zoneProps}>
      <div data-testid="transcript" />
      {scope.provide(<ChoosingBox chosen={props.chosen} />)}
      {scope.overlay}
    </div>
  );
}

function FreshHandlersPane() {
  const scope = useComposerDropScope();
  return (
    <div data-testid="pane" className="relative" {...scope.zoneProps}>
      <div data-testid="transcript" />
      {scope.provide(<FreshHandlersBox />)}
      {scope.overlay}
    </div>
  );
}

function Pane(props: {
  readonly withBox: boolean;
  readonly sink: ImageAttachmentAttrs[];
  readonly children: ReactNode;
}) {
  const scope = useComposerDropScope();
  return (
    <div data-testid="pane" className="relative" {...scope.zoneProps}>
      <div data-testid="transcript" />
      <div data-testid="own-target" {...REFUSING_DROP_ZONE_PROPS}>
        <div data-testid="own-target-child" />
      </div>
      {props.children}
      {scope.provide(props.withBox ? <ComposerBox sink={props.sink} /> : null)}
      {scope.overlay}
    </div>
  );
}

function InnerPane() {
  const scope = useComposerDropScope();
  return (
    <div data-testid="inner-pane" className="relative" {...scope.zoneProps}>
      <div data-testid="inner-transcript" />
      {scope.provide(<ComposerBox sink={inserted} />)}
      {scope.overlay}
    </div>
  );
}

beforeEach(() => {
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  inserted.length = 0;
  outerInserted.length = 0;
  freshBoxRenders.count = 0;
  sinkA.length = 0;
  sinkB.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("a pane that is one file-drop zone for the message box inside it", () => {
  it("shows one overlay, the pane's, when a file is dragged over the pane outside the box", () => {
    render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );

    fireEvent.dragEnter(screen.getByTestId("transcript"), {
      dataTransfer: imageTransfer(),
    });

    const overlays = screen.getAllByText(OVERLAY_TITLE);
    expect(overlays).toHaveLength(1);
    expect(screen.getByTestId("pane").contains(overlays[0])).toBe(true);
    expect(screen.getByTestId("box-frame").contains(overlays[0])).toBe(false);
  });

  it("delivers an image dropped outside the box to the box's editor and clears the overlay", async () => {
    render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );
    const transcript = screen.getByTestId("transcript");
    fireEvent.dragEnter(transcript, { dataTransfer: imageTransfer() });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);

    perform("drop", transcript, imageTransfer());

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0].fileName).toBe("shot.png");
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
  });

  it("keeps a file dropped inside an element that refuses drops from the pane's box", async () => {
    render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );
    const child = screen.getByTestId("own-target-child");

    fireEvent.dragEnter(child, { dataTransfer: imageTransfer() });
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();

    expect(fireEvent.drop(child, { dataTransfer: imageTransfer() })).toBe(
      false,
    );
    // The pane's own drop is delivered on a later turn; wait for one that
    // would have been, by dropping on the transcript afterwards.
    perform("drop", screen.getByTestId("transcript"), imageTransfer());
    await waitFor(() => expect(inserted).toHaveLength(1));
  });

  it("leaves a drop on a portalled element, such as a dialog, alone", () => {
    render(
      <Pane withBox sink={inserted}>
        {createPortal(<div data-testid="portalled" />, document.body)}
      </Pane>,
    );
    const portalled = screen.getByTestId("portalled");

    fireEvent.dragEnter(portalled, { dataTransfer: imageTransfer() });
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();

    expect(fireEvent.drop(portalled, { dataTransfer: imageTransfer() })).toBe(
      true,
    );
    expect(inserted).toEqual([]);
  });

  it("is no zone once the box is gone", () => {
    const { rerender } = render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );
    rerender(
      <Pane withBox={false} sink={inserted}>
        {null}
      </Pane>,
    );

    fireEvent.dragEnter(screen.getByTestId("transcript"), {
      dataTransfer: imageTransfer(),
    });

    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
  });
});

describe("a pane with no box, and the end of a drag", () => {
  it("refuses a file dragged over it and a file dropped on it", () => {
    render(
      <Pane withBox={false} sink={inserted}>
        {null}
      </Pane>,
    );
    const transcript = screen.getByTestId("transcript");

    const fileOver = writableImageTransfer();
    expect(fireEvent.dragOver(transcript, { dataTransfer: fileOver })).toBe(
      false,
    );
    expect(fileOver.dropEffect).toBe("none");
    const fileDrop = { ...imageTransfer(), dropEffect: "copy" };
    expect(fireEvent.drop(transcript, { dataTransfer: fileDrop })).toBe(false);
    expect(fileDrop.dropEffect).toBe("none");
    const pathDrop = {
      ...uriOnlyTransfer("file:///tmp/a.txt"),
      dropEffect: "copy",
    };
    expect(fireEvent.drop(transcript, { dataTransfer: pathDrop })).toBe(false);
    expect(pathDrop.dropEffect).toBe("none");
  });

  it("holds a dragged link for its drop to decide and lets the drop through", () => {
    render(
      <Pane withBox={false} sink={inserted}>
        {null}
      </Pane>,
    );
    const transcript = screen.getByTestId("transcript");

    const linkOver = {
      ...uriOnlyTransfer("https://example.com"),
      dropEffect: "move",
    };
    expect(fireEvent.dragOver(transcript, { dataTransfer: linkOver })).toBe(
      false,
    );
    expect(linkOver.dropEffect).toBe("move");
    const linkDrop = {
      ...uriOnlyTransfer("https://example.com"),
      dropEffect: "copy",
    };
    expect(fireEvent.drop(transcript, { dataTransfer: linkDrop })).toBe(true);
    expect(linkDrop.dropEffect).toBe("copy");
    expect(fireEvent.drop(transcript, { dataTransfer: textTransfer() })).toBe(
      true,
    );
  });

  it("drops the overlay and refuses file drags when the box goes while a drag is over the pane", () => {
    const { rerender } = render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );
    const transcript = screen.getByTestId("transcript");
    fireEvent.dragEnter(transcript, { dataTransfer: imageTransfer() });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);

    rerender(
      <Pane withBox={false} sink={inserted}>
        {null}
      </Pane>,
    );

    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
    const fileOver = writableImageTransfer();
    expect(fireEvent.dragOver(transcript, { dataTransfer: fileOver })).toBe(
      false,
    );
    expect(fileOver.dropEffect).toBe("none");
  });

  it("starts the next drag from nothing when the pane was hidden under a drag", () => {
    render(
      <>
        <Pane withBox sink={inserted}>
          {null}
        </Pane>
        <div data-testid="outside" />
      </>,
    );
    const pane = screen.getByTestId("pane");
    const transcript = screen.getByTestId("transcript");
    fireEvent.dragEnter(transcript, { dataTransfer: imageTransfer() });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);

    pane.style.display = "none";
    fireEvent.dragOver(screen.getByTestId("outside"), {
      dataTransfer: imageTransfer(),
    });
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();

    pane.style.display = "";
    fireEvent.dragEnter(transcript, { dataTransfer: imageTransfer() });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);
    fireEvent.dragLeave(transcript, { dataTransfer: imageTransfer() });
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
  });

  it("clears the overlay when the drag is seen outside the pane", () => {
    render(
      <>
        <Pane withBox sink={inserted}>
          {null}
        </Pane>
        <div data-testid="outside" />
      </>,
    );
    fireEvent.dragEnter(screen.getByTestId("transcript"), {
      dataTransfer: imageTransfer(),
    });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);

    fireEvent.dragOver(screen.getByTestId("outside"), {
      dataTransfer: imageTransfer(),
    });

    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
  });

  it("clears the overlay when the drag ends elsewhere", () => {
    render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );
    fireEvent.dragEnter(screen.getByTestId("transcript"), {
      dataTransfer: imageTransfer(),
    });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);

    fireEvent.dragEnd(window);

    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
  });

  it("gives a drop over a nested pane to the inner box alone", async () => {
    render(
      <Pane withBox sink={outerInserted}>
        <div data-testid="inner-pane-slot">
          <InnerPane />
        </div>
      </Pane>,
    );
    const innerTranscript = screen.getByTestId("inner-transcript");

    fireEvent.dragEnter(innerTranscript, { dataTransfer: imageTransfer() });
    const overlays = screen.getAllByText(OVERLAY_TITLE);
    expect(overlays).toHaveLength(1);
    expect(screen.getByTestId("inner-pane").contains(overlays[0])).toBe(true);

    perform("drop", innerTranscript, imageTransfer());

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(outerInserted).toEqual([]);
  });
});

describe("a box whose handlers are new on every render", () => {
  it("claims its pane once, shows the pane's overlay and takes a drop, without looping", async () => {
    render(<FreshHandlersPane />);
    const transcript = screen.getByTestId("transcript");

    fireEvent.dragEnter(transcript, { dataTransfer: imageTransfer() });
    expect(screen.getAllByText(OVERLAY_TITLE)).toHaveLength(1);

    perform("drop", transcript, imageTransfer());

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
    expect(freshBoxRenders.count).toBeLessThan(10);
  });
});

describe("a box whose handlers change without a drag in progress", () => {
  it("has the latest handlers take the drop", async () => {
    const { rerender } = render(<ChoosingPane chosen="a" />);
    rerender(<ChoosingPane chosen="b" />);

    perform("drop", screen.getByTestId("transcript"), imageTransfer());

    await waitFor(() => expect(sinkB).toHaveLength(1));
    expect(sinkA).toEqual([]);
  });
});

describe("a message box with no pane around it", () => {
  it("keeps its own overlay inside its frame and takes a drop there", async () => {
    render(<ComposerBox sink={inserted} />);
    const frame = screen.getByTestId("box-frame");

    fireEvent.dragEnter(frame, { dataTransfer: imageTransfer() });

    const overlays = screen.getAllByText(OVERLAY_TITLE);
    expect(overlays).toHaveLength(1);
    expect(frame.contains(overlays[0])).toBe(true);

    perform("drop", frame, imageTransfer());

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
  });
});
