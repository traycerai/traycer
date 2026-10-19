import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import { createContext, useContext } from "react";
import type {
  CanvasBoard,
  CanvasNote,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import type { Node } from "@xyflow/react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { CanvasFrameEvents } from "./canvas-frame";
export interface CanvasNodeData extends Record<string, unknown> {
  readonly path: string;
  readonly board: CanvasBoard | null;
  readonly note: CanvasNote | null;
  readonly live: boolean;
  readonly play: boolean;
}
export type CanvasFlowNode = Node<CanvasNodeData>;
export interface CanvasNodeActions {
  readonly viewOnly: boolean;
  readonly selectionEnabled: boolean;
  /** Hand tool or Space held: boards pass drags to the canvas so it pans. */
  readonly panMode: boolean;
  readonly onAddError: (path: string, error: CanvasPageError) => void;
  readonly sourceForBoard: (path: string) => SandboxSource | null;
  readonly frameEvents: CanvasFrameEvents | null;
  readonly renameBoard: (path: string, title: string) => void;
  readonly toggleInteractive: (path: string) => void;
  readonly resize: (
    id: string,
    frame: { x: number; y: number; width: number; height: number },
  ) => void;
  readonly setNoteText: (id: string, text: string) => void;
  /** Patches note fields (text, size, colour) through one layout transaction. */
  readonly updateNote: (id: string, patch: CanvasNote) => void;
  /** The note whose text is being edited in place; a placed note starts here. */
  readonly editingNote: string | null;
  readonly setEditingNote: (id: string | null) => void;
  /** Writes a measured height for a board whose layout entry has none yet. */
  readonly fitBoardHeight: (path: string, height: number) => void;
  readonly fullscreen: (path: string) => void;
}
export const CanvasNodeContext = createContext<CanvasNodeActions | null>(null);
export function useCanvasNodeActions(): CanvasNodeActions {
  const actions = useContext(CanvasNodeContext);
  if (actions === null)
    throw new Error("Canvas nodes require a canvas surface");
  return actions;
}
