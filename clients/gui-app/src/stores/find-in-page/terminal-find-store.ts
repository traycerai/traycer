import { create } from "zustand";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";

export interface TerminalFindController {
  readonly id: string;
  readonly findNext: (
    query: string,
    matchCase: boolean,
    incremental: boolean,
  ) => boolean;
  readonly findPrevious: (query: string, matchCase: boolean) => boolean;
  readonly clear: () => void;
}

interface TerminalFindState {
  readonly activeController: TerminalFindController | null;
}

export const useTerminalFindStore = create<TerminalFindState>(() => ({
  activeController: null,
}));

export function registerActiveTerminalFindController(
  controller: TerminalFindController,
): () => void {
  useTerminalFindStore.setState({ activeController: controller });
  return () => {
    useTerminalFindStore.setState((state) => {
      if (state.activeController !== controller) return state;
      controller.clear();
      useFindInPageStore.getState().setMatches(null);
      return { activeController: null };
    });
  };
}
