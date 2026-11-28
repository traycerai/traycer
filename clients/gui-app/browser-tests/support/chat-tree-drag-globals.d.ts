export type DragStep = "edge" | "middle" | "keyboard";

export interface DragStepResult {
  readonly outcome: "advanced" | "panel-gap" | "committed";
  readonly scrollTop: number;
  readonly scrollGeneration: number;
  readonly keyboardScroll: "offset" | "stationary" | null;
}

declare global {
  interface Window {
    __chatTreeDragProbe: {
      parentOf(id: string): string | null | undefined;
      reparentRequests(): ReadonlyArray<{
        chatId: string;
        newParentId: string | null;
      }>;
      expand(id: string): void;
      collapse(id: string): void;
      armStep(kind: DragStep, pointerY: number | null): void;
      finishInput(): void;
      scrollGeneration(): number;
      stepResult(): Promise<DragStepResult>;
      stopStep(): void;
      frames(last: number): ReadonlyArray<Record<string, unknown>>;
    };
  }
}
