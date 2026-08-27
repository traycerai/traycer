import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Command, CommandInput, CommandList } from "@/components/ui/command";
import { SubpageView } from "@/components/command-palette/palette-cmdk";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

const router: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
  navigateNestedFocus: () => null,
};

const context: CommandContext = {
  pathname: "/",
  router,
  activeTabId: "tab-1",
  activeEpicId: "epic-1",
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

function baseItem(id: string, label: string): CommandItem {
  return {
    id,
    label,
    description: null,
    keywords: [label],
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => undefined,
  };
}

function renderTree(id: "open:agents" | "open:artifacts"): void {
  const items: ReadonlyArray<CommandItem> =
    id === "open:agents"
      ? [
          {
            ...baseItem("root", "Root"),
            agentTreeRow: {
              nodeId: "root",
              depth: 0,
              ancestorIds: [],
              hasChildren: true,
              interface: "chat",
              activity: "idle",
            },
          },
          {
            ...baseItem("child", "Child"),
            agentTreeRow: {
              nodeId: "child",
              depth: 1,
              ancestorIds: ["root"],
              hasChildren: true,
              interface: "chat",
              activity: "idle",
            },
          },
          {
            ...baseItem("grandchild", "Grandchild"),
            agentTreeRow: {
              nodeId: "grandchild",
              depth: 2,
              ancestorIds: ["root", "child"],
              hasChildren: false,
              interface: "chat",
              activity: "idle",
            },
          },
        ]
      : [
          {
            ...baseItem("root", "Root"),
            artifactTreeRow: {
              nodeId: "root",
              depth: 0,
              ancestorIds: [],
              hasChildren: true,
              kind: "story",
              status: 1,
            },
          },
          {
            ...baseItem("child", "Child"),
            artifactTreeRow: {
              nodeId: "child",
              depth: 1,
              ancestorIds: ["root"],
              hasChildren: true,
              kind: "story",
              status: 1,
            },
          },
          {
            ...baseItem("grandchild", "Grandchild"),
            artifactTreeRow: {
              nodeId: "grandchild",
              depth: 2,
              ancestorIds: ["root", "child"],
              hasChildren: false,
              kind: "ticket",
              status: 0,
            },
          },
        ];
  const subpage: CommandSubpage = {
    id,
    title: "Tree",
    useItems: () => items,
  };
  render(
    <Command>
      <CommandInput aria-label="Search" />
      <CommandList>
        <SubpageView
          subpage={subpage}
          ctx={context}
          onSelect={() => undefined}
        />
      </CommandList>
    </Command>,
  );
}

afterEach(() => cleanup());

describe.each(["open:agents", "open:artifacts"] as const)(
  "%s keyboard tree navigation",
  (id) => {
    it("expands with ArrowRight and collapses with ArrowLeft", () => {
      renderTree(id);
      expect(screen.queryByText("Grandchild")).toBeNull();
      const input = screen.getByRole("combobox");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(screen.getByText("Grandchild")).toBeTruthy();
      fireEvent.keyDown(input, { key: "ArrowLeft" });
      expect(screen.queryByText("Grandchild")).toBeNull();
    });
  },
);

it("scopes tree arrows to the command surface receiving the key", () => {
  renderTree("open:agents");
  renderTree("open:agents");
  const [firstInput] = screen.getAllByRole("combobox");
  fireEvent.keyDown(firstInput, { key: "ArrowDown" });
  fireEvent.keyDown(firstInput, { key: "ArrowRight" });
  expect(screen.getAllByText("Grandchild")).toHaveLength(1);
});

it("expands an actionable path branch from the command input", () => {
  const parent = {
    ...baseItem("parent", "Spec"),
    pathTreeRow: {
      treeId: "artifacts",
      nodeId: "parent",
      depth: 0,
      ancestorIds: [],
      hasChildren: true,
      kind: "file" as const,
      path: "parent",
      displayPath: "Spec",
    },
  };
  const child = {
    ...baseItem("child", "Ticket"),
    pathTreeRow: {
      treeId: "artifacts",
      nodeId: "child",
      depth: 1,
      ancestorIds: ["parent"],
      hasChildren: false,
      kind: "file" as const,
      path: "parent/child",
      displayPath: "Spec / Ticket",
    },
  };
  const subpage: CommandSubpage = {
    id: "open:files:artifacts",
    title: "Artifacts",
    useItems: () => [parent, child],
  };
  render(
    <Command>
      <CommandInput />
      <CommandList>
        <SubpageView
          subpage={subpage}
          ctx={context}
          onSelect={() => undefined}
        />
      </CommandList>
    </Command>,
  );
  expect(screen.queryByText("Ticket")).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowRight" });
  expect(screen.getByText("Ticket")).toBeTruthy();
});
