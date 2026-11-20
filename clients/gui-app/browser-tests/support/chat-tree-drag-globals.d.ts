export {};
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
      frames(last: number): ReadonlyArray<Record<string, unknown>>;
    };
  }
}
