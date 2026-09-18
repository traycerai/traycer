import {
  registerCustomizeOptions,
  type CustomizeMove,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import { recordSettingGesture } from "@/lib/customize/history";
import {
  DOCK_SECTION_IDS,
  useLayoutStore,
  type DockSection,
} from "@/stores/settings/layout-store";

const DOCK_SECTION_LABELS: Record<DockSection, string> = {
  filesChanged: "Files changed",
  activeAgents: "Active agents",
  background: "Background",
};

function moveWithinDock(
  order: ReadonlyArray<DockSection>,
  id: DockSection,
  direction: -1 | 1,
): ReadonlyArray<DockSection> | null {
  const index = order.indexOf(id);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= order.length) return null;
  const next = [...order];
  next[index] = next[nextIndex];
  next[nextIndex] = id;
  return next;
}

function moveDockBeforeTarget(
  order: ReadonlyArray<DockSection>,
  id: DockSection,
  targetId: DockSection,
): ReadonlyArray<DockSection> | null {
  if (id === targetId) return null;
  const without = order.filter((section) => section !== id);
  const targetIndex = without.indexOf(targetId);
  const next = [...without];
  next.splice(targetIndex, 0, id);
  return next;
}

function writeDockOrder(label: string, next: ReadonlyArray<DockSection>): void {
  recordSettingGesture("layout.composer.dockOrder", label, ["composer"], () =>
    useLayoutStore.getState().setComposerDockOrder(next),
  );
}

function dockMoves(id: DockSection): ReadonlyArray<CustomizeMove> {
  const order = useLayoutStore.getState().composer.dockOrder;
  const label = DOCK_SECTION_LABELS[id];
  const up = moveWithinDock(order, id, -1);
  const down = moveWithinDock(order, id, 1);
  return [
    {
      id: "move-up",
      label: "Move up",
      announcement: `${label} moved up`,
      disabled: up === null,
      touches: ["composer"],
      analytics: "layout.composer.dockOrder",
      run: () => {
        if (up !== null) writeDockOrder("Move up", up);
      },
    },
    {
      id: "move-down",
      label: "Move down",
      announcement: `${label} moved down`,
      disabled: down === null,
      touches: ["composer"],
      analytics: "layout.composer.dockOrder",
      run: () => {
        if (down !== null) writeDockOrder("Move down", down);
      },
    },
  ];
}

function overIdToDockSection(overId: string): DockSection | null {
  const atIndex = overId.indexOf("@");
  if (atIndex === -1) return null;
  const settingId = overId.slice(0, atIndex);
  const prefix = "composer.";
  if (!settingId.startsWith(prefix)) return null;
  const candidate = settingId.slice(prefix.length);
  return (DOCK_SECTION_IDS as ReadonlyArray<string>).includes(candidate)
    ? (candidate as DockSection)
    : null;
}

function dockDrag(id: DockSection) {
  return {
    group: "composer-dock",
    axis: "vertical" as const,
    resolveDrop: (overId: string): CustomizeMove | null => {
      const targetId = overIdToDockSection(overId);
      if (targetId === null) return null;
      const order = useLayoutStore.getState().composer.dockOrder;
      const next = moveDockBeforeTarget(order, id, targetId);
      if (next === null) return null;
      const label = DOCK_SECTION_LABELS[id];
      return {
        id: "drop",
        label: "Arrange dock",
        announcement: `${label} moved`,
        disabled: false,
        touches: ["composer"] as const,
        analytics: "layout.composer.dockOrder" as const,
        run: () => writeDockOrder("Arrange dock", next),
      };
    },
  };
}

export function registerComposerDockCustomizeOptions(): void {
  registerCustomizeOptions("composer.filesChanged", (): CustomizeOptions => {
    const filesChanged = useLayoutStore.getState().composer.filesChanged;
    return {
      state: filesChanged === "compact" ? "Compact" : "Visible",
      control: {
        id: "composer.filesChanged",
        label: "Files changed",
        touches: ["composer"],
        analytics: "layout.composer.filesChanged",
        kind: "choice",
        value: filesChanged,
        options: [
          {
            value: "visible",
            label: "Visible",
            picture: null,
            override: { composer: { filesChanged: "visible" } },
          },
          {
            value: "compact",
            label: "Compact",
            picture: null,
            override: { composer: { filesChanged: "compact" } },
          },
        ],
        change: (value) => {
          recordSettingGesture(
            "layout.composer.filesChanged",
            value === "compact"
              ? "Compact files changed"
              : "Show files changed",
            ["composer"],
            () =>
              useLayoutStore
                .getState()
                .setComposerFilesChanged(
                  value === "compact" ? "compact" : "visible",
                ),
          );
        },
      },
      moves: dockMoves("filesChanged"),
      drag: dockDrag("filesChanged"),
    };
  });

  registerCustomizeOptions("composer.activeAgents", (): CustomizeOptions => {
    const activeAgents = useLayoutStore.getState().composer.activeAgents;
    return {
      state: activeAgents === "compact" ? "Compact" : "Visible",
      control: {
        id: "composer.activeAgents",
        label: "Active agents",
        touches: ["composer"],
        analytics: "layout.composer.activeAgents",
        kind: "choice",
        value: activeAgents,
        options: [
          {
            value: "visible",
            label: "Visible",
            picture: null,
            override: { composer: { activeAgents: "visible" } },
          },
          {
            value: "compact",
            label: "Compact",
            picture: null,
            override: { composer: { activeAgents: "compact" } },
          },
        ],
        change: (value) => {
          recordSettingGesture(
            "layout.composer.activeAgents",
            value === "compact"
              ? "Compact active agents"
              : "Show active agents",
            ["composer"],
            () =>
              useLayoutStore
                .getState()
                .setComposerActiveAgents(
                  value === "compact" ? "compact" : "visible",
                ),
          );
        },
      },
      moves: dockMoves("activeAgents"),
      drag: dockDrag("activeAgents"),
    };
  });

  registerCustomizeOptions("composer.background", (): CustomizeOptions => {
    const background = useLayoutStore.getState().composer.background;
    return {
      state: background === "compact" ? "Compact" : "Visible",
      control: {
        id: "composer.background",
        label: "Background",
        touches: ["composer"],
        analytics: "layout.composer.background",
        kind: "choice",
        value: background,
        options: [
          {
            value: "visible",
            label: "Visible",
            picture: null,
            override: { composer: { background: "visible" } },
          },
          {
            value: "compact",
            label: "Compact",
            picture: null,
            override: { composer: { background: "compact" } },
          },
        ],
        change: (value) => {
          recordSettingGesture(
            "layout.composer.background",
            value === "compact" ? "Compact background" : "Show background",
            ["composer"],
            () =>
              useLayoutStore
                .getState()
                .setComposerBackground(
                  value === "compact" ? "compact" : "visible",
                ),
          );
        },
      },
      moves: dockMoves("background"),
      drag: dockDrag("background"),
    };
  });
}
