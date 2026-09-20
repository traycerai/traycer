import {
  registerCustomizeOptions,
  type CustomizeDropRefusal,
  type CustomizeMove,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import {
  TOOLBAR_ITEM_IDS,
  useLayoutStore,
  type ComposerToolbarOrder,
  type ToolbarItemId,
} from "@/stores/settings/layout-store";

type ToolbarSide = "left" | "right";

const TOOLBAR_ITEM_LABELS: Record<ToolbarItemId, string> = {
  attachImage: "Attach image",
  access: "Access",
  harness: "Provider",
  model: "Model",
  mic: "Microphone",
};

function sideOf(order: ComposerToolbarOrder, id: ToolbarItemId): ToolbarSide {
  return order.left.includes(id) ? "left" : "right";
}

function otherSide(side: ToolbarSide): ToolbarSide {
  return side === "left" ? "right" : "left";
}

function withoutItem(
  order: ComposerToolbarOrder,
  id: ToolbarItemId,
): ComposerToolbarOrder {
  return {
    left: order.left.filter((item) => item !== id),
    right: order.right.filter((item) => item !== id),
  };
}

/** Swap with the neighbour one step in `direction` within the item's own
 *  cluster. `null` at that cluster's edge - there is nothing to swap with. */
function moveWithinCluster(
  order: ComposerToolbarOrder,
  id: ToolbarItemId,
  direction: -1 | 1,
): ComposerToolbarOrder | null {
  const side = sideOf(order, id);
  const list = order[side];
  const index = list.indexOf(id);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= list.length) return null;
  const next = [...list];
  next[index] = next[nextIndex];
  next[nextIndex] = id;
  return { ...order, [side]: next };
}

/** Jump to the other cluster's end. `null` when that would put `model`
 *  outside `right` - the one placement D13 does not allow. */
function moveToOtherSide(
  order: ComposerToolbarOrder,
  id: ToolbarItemId,
): ComposerToolbarOrder | null {
  const side = sideOf(order, id);
  const next = otherSide(side);
  if (id === "model" && next === "left") return null;
  const cleared = withoutItem(order, id);
  return { ...cleared, [next]: [...cleared[next], id] };
}

/** Insert `id` immediately before `targetId`, in whichever cluster the target
 *  is in. `null` for a no-op drop (dropping onto itself). The `model`-into-left
 *  case is refused by the caller before this runs. */
function moveBeforeTarget(
  order: ComposerToolbarOrder,
  id: ToolbarItemId,
  targetId: ToolbarItemId,
): ComposerToolbarOrder | null {
  if (id === targetId) return null;
  const targetSide = sideOf(order, targetId);
  const cleared = withoutItem(order, id);
  const targetList = cleared[targetSide];
  const targetIndex = targetList.indexOf(targetId);
  const nextList = [...targetList];
  nextList.splice(targetIndex, 0, id);
  return { ...cleared, [targetSide]: nextList };
}

function writeToolbarOrder(next: ComposerToolbarOrder): void {
  useLayoutStore.getState().setComposerToolbarOrder(next);
}

function toolbarMoves(id: ToolbarItemId): ReadonlyArray<CustomizeMove> {
  const order = useLayoutStore.getState().composer.toolbar;
  const label = TOOLBAR_ITEM_LABELS[id];
  const left = moveWithinCluster(order, id, -1);
  const right = moveWithinCluster(order, id, 1);
  const toOtherSide = moveToOtherSide(order, id);
  return [
    {
      id: "move-left",
      label: "Move left",
      announcement: `${label} moved left`,
      disabled: left === null,
      touches: ["composer"],
      analytics: "layout.composer.toolbarOrder",
      run: () => {
        if (left !== null) writeToolbarOrder(left);
      },
    },
    {
      id: "move-right",
      label: "Move right",
      announcement: `${label} moved right`,
      disabled: right === null,
      touches: ["composer"],
      analytics: "layout.composer.toolbarOrder",
      run: () => {
        if (right !== null) writeToolbarOrder(right);
      },
    },
    {
      id: "move-to-other-side",
      label:
        sideOf(order, id) === "left"
          ? "Move to right side"
          : "Move to left side",
      announcement: `${label} moved to the ${sideOf(order, id) === "left" ? "right" : "left"} side`,
      disabled: toOtherSide === null,
      touches: ["composer"],
      analytics: "layout.composer.toolbarOrder",
      run: () => {
        if (toOtherSide !== null) writeToolbarOrder(toOtherSide);
      },
    },
  ];
}

function overIdToToolbarItemId(overId: string): ToolbarItemId | null {
  const atIndex = overId.indexOf("@");
  if (atIndex === -1) return null;
  const settingId = overId.slice(0, atIndex);
  const prefix = "composer.";
  if (!settingId.startsWith(prefix)) return null;
  const candidate = settingId.slice(prefix.length);
  return TOOLBAR_ITEM_IDS.find((id) => id === candidate) ?? null;
}

function toolbarDrag(id: ToolbarItemId) {
  return {
    group: "composer-toolbar",
    axis: "horizontal" as const,
    resolveDrop: (
      overId: string,
    ): CustomizeMove | CustomizeDropRefusal | null => {
      const targetId = overIdToToolbarItemId(overId);
      const slot =
        (["left", "right"] as const).find((side) =>
          overId.startsWith(`toolbar:${side}@`),
        ) ?? null;
      if (targetId === null && slot === null) return null;
      const order = useLayoutStore.getState().composer.toolbar;
      if (slot !== null) {
        if (id === "model" && slot === "left")
          return { refused: "The model chip must stay on the right" };
        const cleared = withoutItem(order, id);
        return {
          id: "drop",
          label: "Arrange toolbar",
          announcement: `${TOOLBAR_ITEM_LABELS[id]} moved`,
          disabled: false,
          touches: ["composer"],
          analytics: "layout.composer.toolbarOrder",
          run: () =>
            writeToolbarOrder({ ...cleared, [slot]: [...cleared[slot], id] }),
        };
      }
      if (targetId === null) return null;
      if (id === "model" && sideOf(order, targetId) === "left") {
        return { refused: "The model chip must stay on the right" };
      }
      const next = moveBeforeTarget(order, id, targetId);
      if (next === null) return null;
      const label = TOOLBAR_ITEM_LABELS[id];
      return {
        id: "drop",
        label: "Arrange toolbar",
        announcement: `${label} moved`,
        disabled: false,
        touches: ["composer"] as const,
        analytics: "layout.composer.toolbarOrder" as const,
        run: () => writeToolbarOrder(next),
      };
    },
  };
}

export function registerComposerToolbarCustomizeOptions(): void {
  registerCustomizeOptions("composer.attachImage", (): CustomizeOptions => {
    const attachImage = useLayoutStore.getState().composer.attachImage;
    return {
      state: attachImage === "hidden" ? "Hidden" : "Visible",
      control: {
        id: "composer.attachImage",
        label: "Attach image",
        touches: ["composer"],
        analytics: "layout.composer.attachImage",
        kind: "choice",
        value: attachImage,
        options: [
          {
            value: "visible",
            label: "Visible",
            picture: null,
            override: { composer: { attachImage: "visible" } },
          },
          {
            value: "hidden",
            label: "Hidden",
            picture: null,
            override: { composer: { attachImage: "hidden" } },
          },
        ],
        change: (value) => {
          useLayoutStore
            .getState()
            .setComposerAttachImage(value === "hidden" ? "hidden" : "visible");
        },
      },
      moves: toolbarMoves("attachImage"),
      drag: toolbarDrag("attachImage"),
    };
  });

  registerCustomizeOptions("composer.access", (): CustomizeOptions => {
    const access = useLayoutStore.getState().composer.access;
    return {
      state: access === "compact" ? "Compact" : "Visible",
      control: {
        id: "composer.access",
        label: "Access",
        touches: ["composer"],
        analytics: "layout.composer.access",
        kind: "choice",
        value: access,
        options: [
          {
            value: "visible",
            label: "Visible",
            picture: null,
            override: { composer: { access: "visible" } },
          },
          {
            value: "compact",
            label: "Compact",
            picture: null,
            override: { composer: { access: "compact" } },
          },
        ],
        change: (value) => {
          useLayoutStore
            .getState()
            .setComposerAccess(value === "compact" ? "compact" : "visible");
        },
      },
      moves: toolbarMoves("access"),
      drag: toolbarDrag("access"),
    };
  });

  registerCustomizeOptions("composer.harness", (): CustomizeOptions => {
    return {
      state: "Shown",
      control: null,
      moves: toolbarMoves("harness"),
      drag: toolbarDrag("harness"),
    };
  });

  registerCustomizeOptions("composer.model", (): CustomizeOptions => {
    const composer = useLayoutStore.getState().composer;
    return {
      state: "Shown",
      control: {
        id: "composer.model",
        label: "Model chip",
        touches: ["composer"],
        analytics: "layout.composer.reasoningIndicator",
        kind: "composite",
        primary: {
          id: "composer.model.reasoningIndicator",
          label: "Chip style",
          touches: ["composer"],
          analytics: "layout.composer.reasoningIndicator",
          kind: "choice",
          value: composer.reasoningIndicator,
          options: [
            {
              value: "text",
              label: "Text",
              picture: null,
              override: { composer: { reasoningIndicator: "text" } },
            },
            {
              value: "bars",
              label: "Bars",
              picture: null,
              override: { composer: { reasoningIndicator: "bars" } },
            },
            {
              value: "bars-text",
              label: "Bars + text",
              picture: null,
              override: { composer: { reasoningIndicator: "bars-text" } },
            },
          ],
          change: (value) => {
            if (value !== "text" && value !== "bars" && value !== "bars-text") {
              return;
            }
            useLayoutStore.getState().setComposerReasoningIndicator(value);
          },
        },
        more: [
          {
            id: "composer.model.reasoningFooterControl",
            label: "Picker footer control",
            touches: ["composer"],
            analytics: "layout.composer.reasoningFooterControl",
            kind: "choice",
            value: composer.reasoningFooterControl,
            options: [
              {
                value: "slider",
                label: "Slider",
                picture: null,
                override: { composer: { reasoningFooterControl: "slider" } },
              },
              {
                value: "list",
                label: "List",
                picture: null,
                override: { composer: { reasoningFooterControl: "list" } },
              },
            ],
            change: (value) => {
              if (value !== "slider" && value !== "list") return;
              useLayoutStore
                .getState()
                .setComposerReasoningFooterControl(value);
            },
          },
        ],
      },
      // No "move to other side": the model picker anchors the footer controls
      // that hang off it, so it stays in `right` (D13). Left/right within the
      // cluster and a refused cross-cluster drop still apply.
      moves: toolbarMoves("model").filter(
        (move) => move.id !== "move-to-other-side",
      ),
      drag: toolbarDrag("model"),
    };
  });

  registerCustomizeOptions("composer.mic", (): CustomizeOptions => {
    const mic = useLayoutStore.getState().composer.mic;
    return {
      state: mic === "hidden" ? "Hidden" : "Visible",
      control: {
        id: "composer.mic",
        label: "Microphone",
        touches: ["composer"],
        analytics: "layout.composer.mic",
        kind: "choice",
        value: mic,
        options: [
          {
            value: "visible",
            label: "Visible",
            picture: null,
            override: { composer: { mic: "visible" } },
          },
          {
            value: "hidden",
            label: "Hidden",
            picture: null,
            override: { composer: { mic: "hidden" } },
          },
        ],
        change: (value) => {
          useLayoutStore
            .getState()
            .setComposerMic(value === "hidden" ? "hidden" : "visible");
        },
      },
      moves: toolbarMoves("mic"),
      drag: toolbarDrag("mic"),
    };
  });
}
