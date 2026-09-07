/**
 * "Open into target" source.
 * Emits the opener's category entries ONLY when the palette is bound to a target group (`ctx.targetGroupId !== null`); the global palette never sees them.
 */
import { useArtifactsOpenerItems } from "@/lib/commands/sources/open/artifacts-subpage";
import { useBrowserOpenerItems } from "@/lib/commands/sources/open/browser-subpage";
import { useAgentsOpenerItems } from "@/lib/commands/sources/open/agents-subpage";
import { useDiffOpenerItems } from "@/lib/commands/sources/open/diff-subpage";
import { useFilesOpenerItems } from "@/lib/commands/sources/open/files-subpage";
import { useSearchOpenerItems } from "@/lib/commands/sources/open/search-subpage";
import { useTerminalsOpenerItems } from "@/lib/commands/sources/open/terminals-subpage";
import { commGraphOpenerItem } from "@/lib/commands/sources/open/comm-graph-leaf";
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
    // ONE Agent category.
    // Chat and Terminal are interfaces within it, not peer collections - splitting them here restated an interface as an entity.
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
    id: "browser",
    title: "Browser",
    keywords: ["browser", "web", "page"],
    useItems: useBrowserOpenerItems,
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
  {
    id: "search",
    title: "Text search",
    keywords: ["search", "text", "grep", "find", "content", "code"],
    useItems: useSearchOpenerItems,
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
  getItems: (ctx) =>
    ctx.targetGroupId === null
      ? []
      : // The communication graph is a LEAF, not a category: there is exactly
        // one graph per epic, so a sub-page listing one row would be a wasted
        // step. It also needs no host pick - the tile fans in across hosts.
        [...CATEGORY_ENTRIES, commGraphOpenerItem(ctx)],
};
