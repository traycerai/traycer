import * as Y from "yjs";
import {
  openCanvasLayout,
  readCanvasLayout,
  type CanvasLayoutHandle,
  type CanvasLayoutSnapshot,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import { CANVAS_LOCAL_ORIGIN } from "./canvas-model";

export interface CanvasLayoutState {
  readonly layout: CanvasLayoutSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}
/** Observes the four independent roots, and owns undo only while a view is subscribed. */
export class CanvasLayoutStore {
  readonly handle: CanvasLayoutHandle;
  private state: CanvasLayoutState;
  private readonly listeners = new Set<() => void>();
  private undoManager: Y.UndoManager | null = null;
  constructor(
    readonly doc: Y.Doc,
    artifactId: string,
  ) {
    this.handle = openCanvasLayout(doc, artifactId);
    this.state = {
      layout: readCanvasLayout(this.handle),
      canUndo: false,
      canRedo: false,
    };
  }
  private roots = (): Y.Map<unknown>[] => [
    this.handle.root,
    this.handle.pages,
    this.handle.boards,
    this.handle.notes,
  ];
  private publish = (): void => {
    this.state = {
      layout: readCanvasLayout(this.handle),
      canUndo: this.undoManager?.canUndo() ?? false,
      canRedo: this.undoManager?.canRedo() ?? false,
    };
    for (const notify of this.listeners) notify();
  };
  readonly getSnapshot = (): CanvasLayoutState => this.state;
  readonly subscribe = (notify: () => void): (() => void) => {
    this.listeners.add(notify);
    if (this.listeners.size === 1) {
      this.undoManager = new Y.UndoManager(this.roots(), {
        trackedOrigins: new Set([CANVAS_LOCAL_ORIGIN]),
      });
      for (const root of this.roots()) root.observeDeep(this.publish);
      this.undoManager.on("stack-item-added", this.publish);
      this.undoManager.on("stack-item-popped", this.publish);
      this.undoManager.on("stack-cleared", this.publish);
      this.publish();
    }
    return () => {
      this.listeners.delete(notify);
      if (this.listeners.size !== 0) return;
      for (const root of this.roots()) root.unobserveDeep(this.publish);
      this.undoManager?.destroy();
      this.undoManager = null;
    };
  };
  readonly transact = (write: (layout: CanvasLayoutHandle) => void): void => {
    this.undoManager?.stopCapturing();
    this.doc.transact(() => write(this.handle), CANVAS_LOCAL_ORIGIN);
    this.undoManager?.stopCapturing();
  };
  readonly undo = (): void => {
    this.undoManager?.undo();
  };
  readonly redo = (): void => {
    this.undoManager?.redo();
  };
}
