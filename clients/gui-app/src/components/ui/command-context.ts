import { createContext, useContext, type RefObject } from "react";

export interface CommandRow {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly keywords: string[];
  readonly disabled: boolean;
  readonly group: string | null;
  readonly element: HTMLDivElement;
  readonly anchor: HTMLTemplateElement;
}

export interface CommandGroupRecord {
  readonly id: string;
  readonly element: HTMLDivElement;
  readonly anchor: HTMLTemplateElement;
}

export interface CommandState {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly highlightedValue: string;
  readonly activeId: string | undefined;
  readonly highlight: (id: string) => void;
  readonly scores: ReadonlyMap<string, number>;
  readonly count: number;
  readonly visibleGroups: ReadonlySet<string>;
  readonly listId: string;
  readonly label: string;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly registerRow: (row: CommandRow) => () => void;
  readonly registerGroup: (group: CommandGroupRecord) => () => void;
}

export const CommandContext = createContext<CommandState | null>(null);
export const CommandGroupContext = createContext<string | null>(null);

export function useCommandContext(): CommandState {
  const context = useContext(CommandContext);
  if (context === null) throw new Error("Command parts require a Command");
  return context;
}

export interface CommandComposition {
  active: boolean;
  endedAt: number;
}

export function isCommandCompositionKey(
  event: KeyboardEvent,
  composition: CommandComposition,
): boolean {
  return (
    event.isComposing ||
    composition.active ||
    (event.key === "Enter" && event.timeStamp - composition.endedAt < 50)
  );
}
