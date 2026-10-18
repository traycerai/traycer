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
  readonly sourceForBoard: (path: string) => SandboxSource | null;
  readonly frameEvents: CanvasFrameEvents | null;
  readonly renameBoard: (path: string, title: string) => void;
  readonly toggleInteractive: (path: string) => void;
  readonly resize: (
    id: string,
    frame: { x: number; y: number; width: number; height: number },
  ) => void;
  readonly setNoteText: (id: string, text: string) => void;
  readonly fullscreen: (path: string) => void;
}
export const CanvasNodeContext = createContext<CanvasNodeActions | null>(null);
export function useCanvasNodeActions(): CanvasNodeActions {
  const actions = useContext(CanvasNodeContext);
  if (actions === null)
    throw new Error("Canvas nodes require a canvas surface");
  return actions;
}
