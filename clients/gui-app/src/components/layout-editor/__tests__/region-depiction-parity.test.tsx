/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { isValidElement, type ElementType, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import { ActiveAgentsHeader } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsHeader } from "@/components/chat/chat-background-items-panel";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { PinnedTodoPanel } from "@/components/chat/chat-pinned-stack";
import { LeftPanelRailIcon } from "@/components/epic-canvas/sidebar/left-panel-rail-icon";
import { ComposerAttachImageTrigger } from "@/components/home/toolbar/composer-attach-image-button";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import { PermissionsTrigger } from "@/components/home/pickers/permissions-picker";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { TabStripHomeItemView } from "@/components/layout/tabs/tab-strip-home-item";
import { MinimapRailTick } from "@/components/minimap/minimap-rail-tick";
import { depictRegion } from "@/components/layout-editor/region-depiction";
import { LAYOUT_REGION_IDS } from "@/components/layout-editor/regions/region-facts";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { SHIPPED_DEFAULT_VALUES } from "@/lib/layout/layout-presets";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * Structural parity (P2, L-11, L-53), at the level a unit test can decide: a
 * picture of a region is drawn BY the component the app draws that region
 * with, that component really paints, and the regions that cannot work this
 * way are enumerated rather than discovered.
 *
 * Three halves, because each alone is fakeable.
 *
 * **Identity.** Every region's depiction is asked for as a React element tree
 * and walked WITHOUT rendering it, so what the walk sees is the element types
 * the depiction module wrote. A `<div>` that merely looks like the real
 * control carries no component identity and fails here. Nothing about class
 * names or markup is asserted, which is what keeps this from restating the
 * implementation.
 *
 * **The app's own leaf.** The module that leaf comes from must be imported by
 * the app OUTSIDE the editor. Without that, "the real component" would mean
 * only "a component", and a look-alike written next door would pass.
 *
 * **DOM.** Rendering the depiction must produce more elements than its own
 * JSX contains, which is only true if the leaf actually painted. This is the
 * half that catches a real component mounted with props that make it draw
 * nothing - a faithful picture of nothing.
 *
 * Whether the two look identical at real widths under real CSS is the browser
 * regression's question (`browser-tests/layout-editor/parity.spec.ts`), which is also
 * where the hover chip's PAINTED position is asserted: anchor positioning
 * resolves to nothing in jsdom.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..", "..");
const EDITOR_DIR = path.join(SRC, "components", "layout-editor");
const DEPICTION_FILE = path.join(EDITOR_DIR, "region-depiction.tsx");

/**
 * How a region is drawn, and against which values.
 *
 * `values` is `null` for the shipped defaults; the four dock rows name both
 * of their sizes, because a chip and a full row are two different real
 * components and a table naming one would leave the other unguarded.
 */
type ParityCase =
  | {
      readonly kind: "real-leaf";
      readonly leaf: ElementType;
      /** The module the leaf comes from, which the app must import too. */
      readonly leafModule: string;
      readonly values: LayoutValues[RegionId] | null;
    }
  | { readonly kind: "own-markup"; readonly reason: string };

function realLeaf(
  leaf: ElementType,
  leafModule: string,
  values: LayoutValues[RegionId] | null,
): ParityCase {
  return { kind: "real-leaf", leaf, leafModule, values };
}

function railIcon(): ParityCase {
  return realLeaf(
    LeftPanelRailIcon,
    "@/components/epic-canvas/sidebar/left-panel-rail-icon",
    null,
  );
}

const CHIP_MODULE = "@/components/chat/chat-dock-compact-chip";
const AS_CHIP: LayoutValues[RegionId] = { shown: "shown", size: "chip" };
const AS_FULL: LayoutValues[RegionId] = { shown: "shown", size: "full" };

/**
 * Every region, said once. A `Record<RegionId, ...>` rather than a list, so a
 * region added without a parity case is a COMPILE error here rather than a
 * region nothing ever compares.
 */
const REGION_PARITY: Readonly<Record<RegionId, ReadonlyArray<ParityCase>>> = {
  homeTab: [
    realLeaf(
      TabStripHomeItemView,
      "@/components/layout/tabs/tab-strip-home-item",
      null,
    ),
  ],
  usageLimits: [
    realLeaf(
      StatusBarUsageReadings,
      "@/components/layout/status-bar/status-bar-usage-readings",
      null,
    ),
  ],
  resourceMonitor: [
    {
      kind: "own-markup",
      reason:
        "StatusBarResourceSegment resolves its readings through useStatusBarResourceMetrics, which subscribes to the desktop sampler and the resource registry, so a picture of it cannot be one of its mounts",
    },
  ],
  minimap: [
    realLeaf(MinimapRailTick, "@/components/minimap/minimap-rail-tick", null),
  ],
  contextUsage: [
    {
      kind: "own-markup",
      reason:
        "ContextUsageChipView reads its style and its pin through the preference seam rather than from props, so a picture of it would be a second reader of the seam",
    },
  ],
  toolActivity: [
    {
      kind: "own-markup",
      reason:
        "depictTranscriptDisclosure draws from ActivityGroupSegment's own classes rather than through it, because the real row reads its open state from a per-chat store a picture must not mount",
    },
  ],
  thinking: [
    {
      kind: "own-markup",
      reason:
        "depictTranscriptDisclosure draws from ReasoningSegment's own classes rather than through it, because the real row reads its open state from a per-chat store a picture must not mount",
    },
  ],
  timestamps: [
    {
      kind: "own-markup",
      reason:
        "depictTimestamp draws from ChatMessageTimestamp's own classes rather than through it, since the real component subscribes to the live clock tick a picture must not mount",
    },
  ],
  runningAgents: [
    realLeaf(ChatDockCompactChip, CHIP_MODULE, AS_CHIP),
    realLeaf(
      ActiveAgentsHeader,
      "@/components/chat/chat-active-agents-panel",
      AS_FULL,
    ),
  ],
  changedFiles: [
    realLeaf(ChatDockCompactChip, CHIP_MODULE, AS_CHIP),
    realLeaf(
      ChatAccumulatedChangesPanel,
      "@/components/chat/chat-accumulated-changes-panel",
      AS_FULL,
    ),
  ],
  background: [
    realLeaf(ChatDockCompactChip, CHIP_MODULE, AS_CHIP),
    realLeaf(
      BackgroundItemsHeader,
      "@/components/chat/chat-background-items-panel",
      AS_FULL,
    ),
  ],
  todo: [
    realLeaf(ChatDockCompactChip, CHIP_MODULE, AS_CHIP),
    realLeaf(PinnedTodoPanel, "@/components/chat/chat-pinned-stack", AS_FULL),
  ],
  attachImage: [
    realLeaf(
      ComposerAttachImageTrigger,
      "@/components/home/toolbar/composer-attach-image-button",
      null,
    ),
  ],
  access: [
    realLeaf(
      PermissionsTrigger,
      "@/components/home/pickers/permissions-picker",
      null,
    ),
  ],
  model: [
    realLeaf(
      HarnessModelTrigger,
      "@/components/home/pickers/harness-model-trigger",
      null,
    ),
  ],
  mic: [
    {
      kind: "own-markup",
      reason:
        "ComposerMicButton gates itself on the preference rather than taking it as a prop, and a picture must draw it either way",
    },
  ],
  railAgents: [railIcon()],
  railTerminals: [railIcon()],
  railBrowsers: [railIcon()],
  railArtifacts: [railIcon()],
  railFiles: [railIcon()],
  railGitDiff: [railIcon()],
  railPullRequests: [railIcon()],
  railFileTree: [railIcon()],
  railSharing: [railIcon()],
  railComments: [railIcon()],
};

interface LeafCase {
  readonly label: string;
  readonly regionId: RegionId;
  readonly leaf: ElementType;
  readonly leafModule: string;
  readonly depiction: ReactNode;
}

const LEAF_CASES: ReadonlyArray<LeafCase> = LAYOUT_REGION_IDS.flatMap(
  (regionId) =>
    REGION_PARITY[regionId].flatMap((parityCase, index): LeafCase[] =>
      parityCase.kind === "real-leaf"
        ? [
            {
              label: `${regionId}[${String(index)}]`,
              regionId,
              leaf: parityCase.leaf,
              leafModule: parityCase.leafModule,
              depiction: depictRegion(
                regionId,
                parityCase.values ?? SHIPPED_DEFAULT_VALUES[regionId],
                DEFAULT_ARRANGEMENT,
              ),
            },
          ]
        : [],
    ),
);

/**
 * Every component element in a depiction's tree, by identity.
 *
 * The tree is never rendered, so a component's own output is not walked into:
 * what comes back is exactly what the depiction module put in the JSX.
 */
interface WithChildren {
  readonly children: ReactNode;
}

function componentsIn(node: ReactNode): ElementType[] {
  if (Array.isArray(node)) {
    const children: ReadonlyArray<ReactNode> = node;
    return children.flatMap(componentsIn);
  }
  if (!isValidElement<WithChildren>(node)) return [];
  const here: ElementType[] = typeof node.type === "string" ? [] : [node.type];
  return [...here, ...componentsIn(node.props.children)];
}

/** The same walk, counting the elements the depiction drew ITSELF. */
function ownElementCount(node: ReactNode): number {
  if (Array.isArray(node)) {
    const children: ReadonlyArray<ReactNode> = node;
    return children.reduce<number>(
      (total, child) => total + ownElementCount(child),
      0,
    );
  }
  if (!isValidElement<WithChildren>(node)) return 0;
  const here = typeof node.type === "string" ? 1 : 0;
  return here + ownElementCount(node.props.children);
}

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.querySelector("[data-layout-depiction]");
  if (!(frame instanceof HTMLElement)) throw new Error("no depiction frame");
  return frame;
}

/** Every app source file outside the editor, for the import check below. */
function appSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test-support")
        return [];
      if (full === EDITOR_DIR) return [];
      return appSources(full);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [readFileSync(full, "utf8")]
      : [];
  });
}

afterEach(cleanup);

describe("every region has a parity case", () => {
  it("covers the registry, with nothing left over", () => {
    expect([...Object.keys(REGION_PARITY)].sort()).toEqual(
      [...LAYOUT_REGION_IDS].sort(),
    );
    for (const regionId of LAYOUT_REGION_IDS) {
      expect(REGION_PARITY[regionId].length, regionId).toBeGreaterThan(0);
    }
  });
});

describe("a depiction draws the app's own leaf", () => {
  it.each(LEAF_CASES)("$label renders the real component", (leafCase) => {
    expect(componentsIn(leafCase.depiction)).toContain(leafCase.leaf);
  });

  it.each(LEAF_CASES)("$label paints something of its own", (leafCase) => {
    const { container } = render(leafCase.depiction);
    const frame = frameOf(container);
    expect(frame.querySelectorAll("*").length).toBeGreaterThan(
      ownElementCount(leafCase.depiction),
    );
  });

  it("draws every leaf from a module the app itself imports", () => {
    const sources = appSources(SRC);
    for (const leafModule of new Set(
      LEAF_CASES.map((leafCase) => leafCase.leafModule),
    )) {
      const importers = sources.filter((source) =>
        source.includes(`from "${leafModule}"`),
      );
      expect(importers.length, leafModule).toBeGreaterThan(0);
    }
  });
});

describe("the depictions drawn from their own markup", () => {
  /**
   * The count is the guard. Adding a region that draws a look-alike fails the
   * identity check above, and the only way to make that pass is to declare it
   * here - which moves this list and fails again, in front of a reviewer.
   */
  it("are the six the module declares, and no more", () => {
    const ownMarkup = LAYOUT_REGION_IDS.filter((regionId) =>
      REGION_PARITY[regionId].some(
        (parityCase) => parityCase.kind === "own-markup",
      ),
    );
    expect([...ownMarkup].sort()).toEqual([
      "contextUsage",
      "mic",
      "resourceMonitor",
      "thinking",
      "timestamps",
      "toolActivity",
    ]);
  });
});

describe("the depiction layer's imports", () => {
  const source = readFileSync(DEPICTION_FILE, "utf8");

  /**
   * A look-alike has to live somewhere, and the one place a reviewer would not
   * look is beside the depictions. Nothing under `layout-editor/` may be drawn
   * INTO a picture except the host frame, which is the picture's own chrome
   * rather than a region's control.
   */
  it("draws nothing of the editor's own, except the host frame", () => {
    const editorImports = [
      ...source.matchAll(/from "(@\/components\/layout-editor\/[^"]+)"/g),
    ].map((match) => match[1]);
    expect(editorImports).toEqual([
      "@/components/layout-editor/region-depiction-frame",
    ]);
  });

  /**
   * The registry used to carry a second pointer at the depiction table, and
   * the callers that read it (the specimen stage, the Style examples) drew
   * their pictures WITHOUT the host frame - the same region, two looks. One
   * way in is what stops that coming back.
   *
   * Asked of the app rather than of the declaration's spelling (G3-17): what
   * matters is that no module OUTSIDE this one reads the table, which a
   * reflowed `const` or a second export under another name would both leave
   * true or false independently of how the declaration is written.
   */
  it("is reachable only through the framed entry point", () => {
    const readers = appSources(SRC).filter((appSource) =>
      appSource.includes("REGION_DEPICTIONS"),
    );
    expect(readers).toEqual([]);
    // The editor's own modules are excluded from `appSources`, so the table's
    // neighbours are checked here by name.
    const editorModules = readdirSync(EDITOR_DIR, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".tsx") &&
          entry.name !== "region-depiction.tsx",
      )
      .map((entry) => readFileSync(path.join(EDITOR_DIR, entry.name), "utf8"));
    for (const neighbour of editorModules)
      expect(neighbour).not.toContain("REGION_DEPICTIONS");
  });
});
