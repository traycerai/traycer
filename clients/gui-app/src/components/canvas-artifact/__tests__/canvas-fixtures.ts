import * as Y from "yjs";
import {
  applyCanvasJson,
  canvasJsonV1Schema,
  openCanvasLayout,
  readCanvasLayout,
  type CanvasLayoutSnapshot,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import { CanvasLayoutStore } from "../canvas-layout-store";

export const ARTIFACT_ID = "artifact-1";

export interface CanvasFixtureFile {
  readonly pages: readonly { readonly id: string; readonly name: string }[];
  readonly boards: Readonly<
    Record<
      string,
      {
        readonly x: number;
        readonly y: number;
        readonly w: number;
        readonly h: number;
        readonly page?: string;
        readonly title?: string;
      }
    >
  >;
  readonly notes: Readonly<
    Record<
      string,
      {
        readonly type: "sticky";
        readonly x: number;
        readonly y: number;
        readonly text: string;
        readonly page?: string;
      }
    >
  >;
  readonly order: readonly string[];
}

/** A real Y.Doc seeded through the same projection the host uses. */
export function docFromFixture(file: CanvasFixtureFile): Y.Doc {
  const doc = new Y.Doc();
  const layout = openCanvasLayout(doc, ARTIFACT_ID);
  const parsed = canvasJsonV1Schema.parse({ v: 1, title: "Study", ...file });
  doc.transact(() => {
    applyCanvasJson(layout, parsed, {
      protectedBoardPaths: [],
      baseline: null,
    });
  });
  return doc;
}

export function snapshotFromFixture(
  file: CanvasFixtureFile,
): CanvasLayoutSnapshot {
  return readCanvasLayout(openCanvasLayout(docFromFixture(file), ARTIFACT_ID));
}

export function storeFromFixture(file: CanvasFixtureFile): CanvasLayoutStore {
  return new CanvasLayoutStore(docFromFixture(file), ARTIFACT_ID);
}
