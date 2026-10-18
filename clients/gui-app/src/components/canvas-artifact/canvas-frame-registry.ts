import type { CanvasTool } from "./canvas-model";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { SandboxBridgeHost, SandboxSize } from "@/lib/sandbox/bridge-host";

export interface CanvasSelectionFrame {
  readonly source: SandboxSource | null;
  readonly retype: {
    readonly id: string;
    readonly generation: number;
    readonly element: CanvasElement;
    readonly sha256: string | null;
    readonly bridge: SandboxBridgeHost;
  } | null;
  readonly bridge: SandboxBridgeHost | null;
  readonly frame: HTMLIFrameElement | null;
  readonly sha256: string | null;
  readonly page: string | null;
  readonly size: SandboxSize | null;
}
const EMPTY_FRAME: CanvasSelectionFrame = {
  source: null,
  retype: null,
  bridge: null,
  frame: null,
  sha256: null,
  page: null,
  size: null,
};

export interface CanvasCommentView {
  readonly tool: CanvasTool;
  readonly play: boolean;
  readonly viewOnly: boolean;
  readonly order: readonly string[];
  readonly sourceForBoard: (path: string) => SandboxSource | null;
  readonly revealBoard: (path: string) => void;
  readonly setTool: (tool: CanvasTool) => void;
}

/** The mounted frame's immutable source identity and current DOM geometry. */
export class CanvasFrameRegistry {
  private readonly frames = new Map<string, CanvasSelectionFrame>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  boardPath: string | null = null;
  view: CanvasCommentView | null = null;
  setView(view: CanvasCommentView | null): void {
    this.view = view;
    this.changed();
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): number => this.version;
  get(path: string): CanvasSelectionFrame {
    return this.frames.get(path) ?? EMPTY_FRAME;
  }
  update(path: string, update: Partial<CanvasSelectionFrame>): void {
    const previous = this.get(path);
    const next = { ...previous, ...update };
    if (
      next.bridge !== previous.bridge ||
      next.frame !== previous.frame ||
      next.source !== previous.source ||
      next.sha256 !== previous.sha256
    )
      next.retype = null;
    this.frames.set(path, next);
    this.changed();
  }
  selectBoard(path: string | null): void {
    this.boardPath = path;
    this.changed();
  }
  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
