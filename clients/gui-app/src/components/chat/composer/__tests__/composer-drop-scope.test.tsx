/**
 * A pane that is one drop zone for the message box inside it, through the real
 * `useComposerHashPaste`: the box's own drag handlers decide what is accepted
 * and what a drop delivers, the pane only widens where the gesture is taken.
 * The editor is a handle that records the image attachments it is given.
 */
import { useRef, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OWN_DROP_TARGET_PROPS,
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

// Stable across renders, as the composer's own are: a fresh object per render
// would hand the pane a new target every time and never settle.
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

function Pane(props: {
  readonly withBox: boolean;
  readonly sink: ImageAttachmentAttrs[];
  readonly children: ReactNode;
}) {
  const scope = useComposerDropScope();
  return (
    <div data-testid="pane" className="relative" {...scope.zoneProps}>
      <div data-testid="transcript" />
      <div data-testid="own-target" {...OWN_DROP_TARGET_PROPS} />
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

  it("shows no pane overlay for a drag entering an element that takes drops itself", () => {
    render(
      <Pane withBox sink={inserted}>
        {null}
      </Pane>,
    );

    fireEvent.dragEnter(screen.getByTestId("own-target"), {
      dataTransfer: imageTransfer(),
    });

    expect(screen.queryByText(OVERLAY_TITLE)).toBeNull();
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
  it("refuses a file drag and a file drop, and leaves a text drag alone", () => {
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
    expect(fireEvent.drop(transcript, { dataTransfer: imageTransfer() })).toBe(
      false,
    );

    expect(
      fireEvent.dragOver(transcript, { dataTransfer: textTransfer() }),
    ).toBe(true);
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
