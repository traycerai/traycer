import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  applyCanvasJson,
  openCanvasLayout,
  type CanvasBoard,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { CanvasArtifactFixture } from "./canvas-surface-context";
export interface CanvasProofFixture {
  readonly artifact: ArtifactProjection;
  readonly binding: CanvasArtifactFixture;
  readonly dispose: () => void;
}
export function createCanvasProofFixture(): CanvasProofFixture {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const artifactId = "canvas-surface-proof";
  const files: Record<string, ArtifactObjectRef> = {};
  const blobs = new Map<string, Uint8Array>();
  const boards: Record<string, CanvasBoard> = {};
  const encoder = new TextEncoder();
  for (let index = 0; index < 12; index++) {
    const path = `boards/screen-${index + 1}.html`;
    const title =
      ["Welcome", "Choose a project"].at(index) ?? `Screen ${index + 1}`;
    const html = `<!doctype html><html><head><style>body{margin:0;padding:32px;font-family:var(--font-sans);color:var(--color-text-primary);background:var(--color-background-primary)}h1{font-size:32px}button{font:inherit;padding:12px 18px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit}p{line-height:1.6;color:var(--color-text-secondary)}section{padding-top:24px}</style></head><body><p>Project flow</p><h1>${title}</h1><p>A place to gather ideas and turn them into something useful.</p><section><button id="next">Continue</button><p id="result">Ready when you are.</p></section><script>let count=0;document.getElementById('next').onclick=()=>document.getElementById('result').textContent='Clicked '+(++count)+' times';</script></body></html>`;
    const bytes = encoder.encode(html);
    const sha256 = String(index + 1).padStart(64, "0");
    blobs.set(sha256, bytes);
    files[path] = {
      sha256,
      byteLength: bytes.length,
      mediaType: "text/html",
      status: "local-only",
    };
    boards[path] = {
      x: (index % 4) * 560,
      y: Math.floor(index / 4) * 520,
      w: 480,
      h: 380,
      title,
      page: index < 10 ? "flow" : "details",
      is_interactive: index === 1,
    };
  }
  const svg = encoder.encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" rx="12" fill="#546e7a"/><circle cx="100" cy="60" r="30" fill="#fff"/></svg>',
  );
  const sha256 = "f".repeat(64);
  blobs.set(sha256, svg);
  files["assets/image.svg"] = {
    sha256,
    byteLength: svg.length,
    mediaType: "image/svg+xml",
    status: "local-only",
  };
  applyCanvasJson(
    openCanvasLayout(doc, artifactId),
    {
      v: 1,
      title: "Project flow",
      pages: [
        { id: "flow", name: "Flow" },
        { id: "details", name: "Details" },
      ],
      boards,
      notes: {
        title: {
          type: "title",
          x: 0,
          y: -150,
          w: 500,
          h: 70,
          text: "From idea to project",
        },
        sticky: {
          type: "sticky",
          x: -260,
          y: 30,
          w: 200,
          h: 160,
          text: "Keep the first step simple.",
        },
        arrow: {
          type: "arrow",
          x: 480,
          y: 180,
          x2: 560,
          y2: 180,
          w: 80,
          h: 12,
        },
        image: {
          type: "image",
          x: -260,
          y: 250,
          w: 200,
          h: 120,
          src: "assets/image.svg",
          text: "Reference",
        },
      },
      order: Object.keys(boards),
    },
    { baseline: null, protectedBoardPaths: [] },
  );
  const artifact: ArtifactProjection = {
    id: artifactId,
    kind: "canvas",
    title: "Project flow",
    layout: "folder",
    folderName: "canvas-proof",
    parentId: null,
    artifactRoomId: "proof-room",
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
    head: { files, capturedAt: 0 },
  };
  return {
    artifact,
    binding: {
      doc,
      awareness,
      treePath: "canvas-proof",
      user: { name: "You", color: "#14b8a6" },
      resolveOutsideReference: () => null,
      readSpan: (hash, offset, length, signal) => {
        signal.throwIfAborted();
        const bytes = blobs.get(hash);
        if (bytes === undefined)
          return Promise.resolve({ unavailable: "missing" });
        return Promise.resolve({
          bytes: bytes.slice(offset, offset + length),
          totalBytes: bytes.length,
          mediaType: hash === sha256 ? "image/svg+xml" : "text/html",
        });
      },
    },
    dispose: () => {
      awareness.destroy();
      doc.destroy();
    },
  };
}

/** Allocate live Yjs/awareness resources at subscription, including Strict Mode remounts. */
export function createCanvasProofStore() {
  let current: CanvasProofFixture | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): CanvasProofFixture | null => current,
    subscribe: (notify: () => void): (() => void) => {
      listeners.add(notify);
      if (current === null) {
        current = createCanvasProofFixture();
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
