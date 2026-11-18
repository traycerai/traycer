import {
  openCanvasLayout,
  setBoardMetadata,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  createCanvasProofFixture,
  type CanvasProofFixture,
} from "./canvas-proof-fixture";

export const CANVAS_PROOF_EPIC_ID = "canvas-proof";
export const CANVAS_PROOF_VIEW_TAB_ID = "canvas-proof-view";

const BOARDS = [
  {
    title: "Welcome",
    body: '<h1 data-tid="welcome-title">Welcome</h1><p data-tid="welcome-text">Select this text to format it or add it to chat.</p><p>Double-click the selected heading to retype it.</p>',
    style: "",
    script: "",
  },
  {
    title: "Links",
    body: '<h1>Links</h1><p><a href="./screen-1.html">Back to Welcome</a></p><p><a href="https://example.com/canvas-proof">Open example.com</a></p><p>Switch the canvas to Play to follow these links.</p>',
    style: "",
    script: "",
  },
  {
    title: "Page error",
    body: "<h1>Page error</h1><p>The page throws an error when it loads.</p>",
    style: "",
    script:
      'window.addEventListener("load", () => { throw new Error("Canvas proof: page failed on load"); });',
  },
  {
    title: "Theme tweaks",
    body: '<h1>Theme tweaks</h1><p id="theme-sample">Change the accent, spacing, or greeting in Tweaks.</p>',
    style:
      ':root{--accent-color:#6366f1;--sample-spacing:24px;--greeting:"Hello"}#theme-sample{border-left:6px solid var(--accent-color);padding:var(--sample-spacing)}',
    script: "",
  },
  {
    title: "Image swap",
    body: '<h1>Image swap</h1><img data-tid="proof-image" src="../assets/image.svg" alt="Canvas proof illustration" width="200" height="120"><p>Select the illustration to replace or paste an image.</p>',
    style: "",
    script: "",
  },
  {
    title: "Script-changed text",
    body: '<h1>Script-changed text</h1><p data-tid="script-text" id="live-text">Hello world</p><p>Select Hello or double-click the paragraph to see the text-change note.</p>',
    style: "",
    script:
      'document.getElementById("live-text").textContent="NEW Hello world";',
  },
  {
    title: "Generated content",
    body: '<h1>Generated content</h1><section id="generated-root"></section><p>Select the generated paragraph to see its editing note and Add to chat.</p>',
    style: "",
    script:
      'const paragraph=document.createElement("p");paragraph.id="generated-text";paragraph.textContent="This paragraph was created by the page.";document.getElementById("generated-root").append(paragraph);',
  },
] as const;

function proofHtml(board: (typeof BOARDS)[number]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${board.style}body{box-sizing:border-box;margin:0;padding:32px;font-family:var(--font-sans);color:var(--color-text-primary);background:var(--color-background-primary)}h1{font-size:32px}p{line-height:1.6}a{color:var(--color-text-primary)}img{display:block}</style></head><body>${board.body}<script>${board.script}</script></body></html>`;
}

export interface CanvasEditingProofFixture extends CanvasProofFixture {
  readonly epic: OpenEpicStoreHandle;
}

/** Only the route mounts this isolated session; it never opens a task stream. */
export function createCanvasEditingProofFixture(): CanvasEditingProofFixture {
  const fixture = createCanvasProofFixture();
  const files: Record<string, ArtifactObjectRef> = {
    ...fixture.artifact.head?.files,
  };
  const bytesByHash = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const layout = openCanvasLayout(fixture.binding.doc, fixture.artifact.id);
  fixture.binding.doc.transact(() => {
    for (const [index, board] of BOARDS.entries()) {
      const path = `boards/screen-${index + 1}.html`;
      const bytes = encoder.encode(proofHtml(board));
      // Fixture-local addresses, never published as content-addressed objects.
      const sha256 = `e${String(index + 1).padStart(63, "0")}`;
      bytesByHash.set(sha256, bytes);
      files[path] = {
        sha256,
        byteLength: bytes.length,
        mediaType: "text/html",
        status: "local-only",
      };
      setBoardMetadata(layout, path, {
        title: board.title,
        is_interactive: index === 1,
        radius: undefined,
      });
    }
  });
  const artifact = {
    ...fixture.artifact,
    head: { files, capturedAt: 0 },
  };
  // Reuse the existing in-process session harness instead of inventing a partial
  // OpenEpicState. The real edit hook still addresses the route's pinned host;
  // that host refuses this fixture epic/artifact, and the UI shows the refusal.
  const epic = openStoreForTest({
    epicId: CANVAS_PROOF_EPIC_ID,
    userId: null,
    factories: {
      laneSelection: null,
      streamClientFactory: () => ({
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      }),
    },
    writeCommand: null,
  });
  epic.store.setState({
    artifacts: { byId: { [artifact.id]: artifact }, allIds: [artifact.id] },
  });
  return {
    artifact,
    epic,
    binding: {
      ...fixture.binding,
      readSpan: (hash, offset, length, signal) => {
        signal.throwIfAborted();
        const bytes = bytesByHash.get(hash);
        if (bytes === undefined)
          return fixture.binding.readSpan(hash, offset, length, signal);
        return Promise.resolve({
          bytes: bytes.slice(offset, offset + length),
          totalBytes: bytes.length,
          mediaType: "text/html",
        });
      },
    },
    dispose: () => {
      epic.dispose();
      fixture.dispose();
    },
  };
}

export function createCanvasEditingProofStore() {
  let current: CanvasEditingProofFixture | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): CanvasEditingProofFixture | null => current,
    subscribe: (notify: () => void): (() => void) => {
      listeners.add(notify);
      if (current === null) {
        current = createCanvasEditingProofFixture();
        for (const listener of listeners) listener();
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          current?.dispose();
          current = null;
        }
      };
    },
  };
}
