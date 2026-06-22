/**
 * "Open into target" source. Emits the opener's category entries ONLY when the
 * palette is bound to a target group (`ctx.targetGroupId !== null`); the global
 * palette never sees them. Each category pushes a sub-page (reusing the shell's
 * sub-page stack); its leaves open into the bound target group via
 * `openTileIntoTargetGroup` (Decision 2/3 of the pane-opener tech plan).
 *
 * T5 fills Chats / TUI / Terminals / Artifacts (live projection + pinned
 * "New X", default-host bound). T6 fills Files / Diff (two-step workspace →
 * file).
 */
import { useArtifactsOpenerItems } from "@/lib/commands/sources/open/artifacts-subpage";
import { useChatsOpenerItems } from "@/lib/commands/sources/open/chats-subpage";
import { useDiffOpenerItems } from "@/lib/commands/sources/open/diff-subpage";
import { useFilesOpenerItems } from "@/lib/commands/sources/open/files-subpage";
import { useTerminalsOpenerItems } from "@/lib/commands/sources/open/terminals-subpage";
import { useTuiOpenerItems } from "@/lib/commands/sources/open/tui-subpage";
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
    id: "chats",
    title: "Chats",
    keywords: ["chat", "chats"],
    useItems: useChatsOpenerItems,
  },
  {
    id: "tui",
    title: "TUI agents",
    keywords: ["tui", "agent", "agents"],
    useItems: useTuiOpenerItems,
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
