import type { SandboxBridgeHost, SandboxSize } from "@/lib/sandbox/bridge-host";

export interface CanvasSelectionFrame {
  readonly bridge: SandboxBridgeHost | null;
  readonly frame: HTMLIFrameElement | null;
  readonly sha256: string | null;
  readonly page: string | null;
  readonly size: SandboxSize | null;
}
const EMPTY_FRAME: CanvasSelectionFrame = {
  bridge: null,
  frame: null,
  sha256: null,
  page: null,
  size: null,
};

/** The mounted frame's immutable source identity and current DOM geometry. */
export class CanvasFrameRegistry {
  private readonly frames = new Map<string, CanvasSelectionFrame>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  boardPath: string | null = null;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): number => this.version;
  get(path: string): CanvasSelectionFrame {
    return this.frames.get(path) ?? EMPTY_FRAME;
  }
  update(path: string, update: Partial<CanvasSelectionFrame>): void {
    this.frames.set(path, { ...this.get(path), ...update });
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
