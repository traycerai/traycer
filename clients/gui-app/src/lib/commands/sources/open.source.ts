/**
 * "Open into target" source. Emits the opener's category entries ONLY when the
 * palette is bound to a target group (`ctx.targetGroupId !== null`); the global
 * palette never sees them. Each category pushes a sub-page (reusing the shell's
 * sub-page stack); its leaves open into the bound target group via
 * `openTileIntoTargetGroup` (Decision 2/3 of the pane-opener tech plan).
 *
 * T5 fills Agents / Terminals / Artifacts (live projection + pinned
 * creation leaves, default-host bound). T6 fills Files / Diff (two-step
 * workspace → file).
 */
import { useArtifactsOpenerItems } from "@/lib/commands/sources/open/artifacts-subpage";
import { useAgentsOpenerItems } from "@/lib/commands/sources/open/agents-subpage";
import { useDiffOpenerItems } from "@/lib/commands/sources/open/diff-subpage";
import { useFilesOpenerItems } from "@/lib/commands/sources/open/files-subpage";
import { useTerminalsOpenerItems } from "@/lib/commands/sources/open/terminals-subpage";
import type {
  CommandContext,
  CommandItem,
  CommandSource,
  CommandSubpage,
} from "@/lib/commands/types";

interface OpenerCategory {
  readonly id: string;
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly useItems: (ctx: CommandContext) => ReadonlyArray<CommandItem>;
}

const OPENER_CATEGORIES: ReadonlyArray<OpenerCategory> = [
  {
    // ONE Agent category. Chat and Terminal are interfaces within it, not peer
    // collections - splitting them here restated an interface as an entity.
    // `chat`/`chats`/`tui` stay as keywords so users who learned the old
    // vocabulary still land here: the label moves, discoverability does not.
    id: "agents",
    title: "Agents",
    keywords: ["agent", "agents", "chat", "chats", "tui", "terminal"],
    useItems: useAgentsOpenerItems,
  },
  {
    id: "terminals",
    title: "Terminals",
    keywords: ["terminal", "terminals", "shell"],
    useItems: useTerminalsOpenerItems,
  },
  {
    id: "artifacts",
    title: "Artifacts",
    keywords: ["artifact", "spec", "ticket", "story", "review"],
    useItems: useArtifactsOpenerItems,
  },
  {
    id: "files",
    title: "Files",
    keywords: ["file", "files"],
    useItems: useFilesOpenerItems,
  },
  {
    id: "diff",
    title: "Diff",
    keywords: ["diff", "changes"],
    useItems: useDiffOpenerItems,
  },
];

function makeCategorySubpage(category: OpenerCategory): CommandSubpage {
  return {
    id: `open:${category.id}`,
    title: category.title,
    useItems: category.useItems,
  };
}

function makeCategoryEntry(category: OpenerCategory): CommandItem {
  return {
    id: `open:category:${category.id}`,
    label: category.title,
    description: null,
    keywords: category.keywords,
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: makeCategorySubpage(category),
    run: () => undefined,
  };
}

const CATEGORY_ENTRIES: ReadonlyArray<CommandItem> =
  OPENER_CATEGORIES.map(makeCategoryEntry);

export const openSource: CommandSource = {
  id: "open",
  getItems: (ctx) => (ctx.targetGroupId === null ? [] : CATEGORY_ENTRIES),
};
