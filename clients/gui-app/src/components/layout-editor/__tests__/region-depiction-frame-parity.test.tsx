import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatLowerDock,
  type DockRowHotspot,
} from "@/components/chat/chat-lower-dock";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import {
  ChatDockCompactStripProvider,
  type ChatDockCompactChipModel,
} from "@/components/chat/chat-dock-compact-strip";
import {
  chatDockSection,
  type ChatDockSection,
} from "@/lib/chat/chat-dock-sections";
import { ComposerTileIdProvider } from "@/components/home/composer/composer-tile-context";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/region-drag";
import {
  HostContextFrame,
  type HostContextId,
} from "@/components/layout-editor/region-depiction-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_DOCK_ORDER } from "@/lib/layout/layout-arrangement";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The host frame against the surface it is a copy of (Risk 3, P2).
 *
 * `HOST_CONTEXT_CLASS` copies four real composer surfaces by hand so a picture
 * of a region lands at the surface's own scale, fill and spacing. Every parity
 * suite this repo has compares a PICTURE with a LEAF under that frame, so all
 * of them keep passing while the frame itself drifts away from the surface -
 * they would be measuring the same wrong numbers on both sides. C1 and C2 moved
 * all four of these surfaces at once, which is exactly the round where that
 * would have happened unnoticed.
 *
 * So this renders the real surface and the frame, and compares what they
 * RESOLVE TO rather than string literals: a restated string is the same copy
 * this file exists to catch, one file further from the original.
 *
 * Two directions, because drift has two.
 *
 * 1. Every surface class the real container carries is on the frame. That is
 *    the fill, the border, the radius, the gap, the alignment, the height and
 *    the type scale - what decides how a surface paints and spaces what it
 *    holds. Positional classes are deliberately NOT compared: `mx-3` and
 *    `-mb-px` tuck the dock under a composer, and a picture has no composer to
 *    tuck under.
 * 2. The frame states no type scale the surface does not. Direction 1 cannot
 *    see an invented one, and an invented scale is the whole failure mode the
 *    frame exists to prevent - in reverse.
 *
 * The four hosts here are the four that moved. The other four are named in
 * {@link NO_RENDERABLE_SURFACE} with the reason, so the gap is stated rather
 * than discovered by a count.
 */

const hostHooks = vi.hoisted(() => ({
  schemaVersion: vi.fn((_hostId: string | null, _method: string) => null),
  judgeBilling: vi.fn(
    (_hostId: string | null, _harnessId: string | null) => null,
  ),
}));
// The toolbar's own two host reads, which have nothing to do with how its row
// is laid out. Same pair `composer-toolbar-presentation.test.tsx` fakes to
// mount this component without a host.
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSchemaVersion: hostHooks.schemaVersion,
}));
vi.mock("@/hooks/auto-mode/use-auto-judge-billing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auto-mode/use-auto-judge-billing")
  >()),
  useAutoJudgeBilling: hostHooks.judgeBilling,
}));

/** Why a host's real container is not rendered here, one line each. */
const NO_RENDERABLE_SURFACE: Readonly<Partial<Record<HostContextId, string>>> =
  {
    "top-bar":
      "the tab strip reads the tabs store, the router and the drag layer before it draws a row",
    "status-bar":
      "the strip resolves the watched host's rate-limit subscription and its resource sampler",
    rail: "the epic sidebar rail draws inside an epic surface, with its session, its panel registry and its drop targets",
    chat: "the transcript edge the minimap stands against is the virtualised list's own box, which needs a measured viewport",
  };

/**
 * One host's frame, as classes. Rendered into the same document as whatever
 * else a test has mounted, so nothing has to be torn down to read it.
 */
function frameClasses(host: HostContextId): ReadonlySet<string> {
  const { container } = render(
    <HostContextFrame host={host}>{null}</HostContextFrame>,
  );
  const frame = container.querySelector("[data-layout-depiction]");
  if (!(frame instanceof HTMLElement)) throw new Error(`no frame for ${host}`);
  return new Set(frame.classList);
}

/**
 * Keyed by the union, so a host added to production is a compile error here
 * until this file either renders it or says why not.
 */
const HOSTS: Readonly<Record<HostContextId, true>> = {
  "top-bar": true,
  "status-bar": true,
  toolbar: true,
  "composer-foot": true,
  dock: true,
  "chip-strip": true,
  rail: true,
  chat: true,
};

function isHost(key: string): key is HostContextId {
  return Object.hasOwn(HOSTS, key);
}

const ALL_HOSTS: ReadonlyArray<HostContextId> =
  Object.keys(HOSTS).filter(isHost);

/**
 * The frame's OWN chrome, derived rather than restated: it is what every host's
 * frame has in common, which is exactly the "one line, never wrapped, clipped
 * with a fade" treatment `region-depiction-frame.tsx` applies to all of them.
 * Subtracting it leaves the per-host copy, which is what this file compares.
 */
function frameChrome(): ReadonlySet<string> {
  const lists = ALL_HOSTS.map(frameClasses);
  const [first, ...rest] = lists;
  return new Set(
    [...first].filter((className) =>
      rest.every((other) => other.has(className)),
    ),
  );
}

/**
 * Which classes describe how a surface paints and spaces what it holds.
 *
 * A family list rather than an exact set: the point is to state which
 * DIMENSIONS a picture owes the real thing, and to let the surface's own class
 * list answer what the values are.
 */
function isSurfaceClass(className: string): boolean {
  if (className === "tabular-nums") return true;
  return [
    "bg-",
    "border",
    "rounded",
    "gap-",
    "items-",
    "text-ui",
    "text-code",
    "font-",
    "h-",
  ].some((family) => className.startsWith(family));
}

function isTypeScaleClass(className: string): boolean {
  return className.startsWith("text-") || className === "tabular-nums";
}

// ── The real surfaces ───────────────────────────────────────────────────────

const TILE = "frame-parity-tile";
// Read off the arrangement rather than listed here: dock membership and its
// order are model facts that have already changed twice (L-139, L-142), and a
// list copied into a test is what goes stale while the test stays green.
const DOCK_SECTIONS: ReadonlyArray<ChatDockSection> =
  DEFAULT_DOCK_ORDER.map(chatDockSection);

/**
 * One folded dock member, which is what keeps `ChatLowerDock` alive with no
 * row inside it: the frame element is rendered either way (it is `empty:hidden`,
 * not conditional), so both composer clusters come from one mount and no panel
 * is drawn at all.
 */
const CHIP: ChatDockCompactChipModel = {
  section: "filesChanged",
  glyph: "filesChanged",
  hotspotRef: null,
  working: false,
  lineDeltas: null,
  text: "1",
  label: "Changed files. 1 file changed.",
  detail: "1 file",
  pulseToken: null,
};

const NO_HOTSPOT: DockRowHotspot = {
  hotspotRef: () => undefined,
  shown: false,
  hasContent: false,
  ghost: false,
  editing: false,
};

const EMPTY_QUEUE: ChatSessionState["queue"] = { status: "idle", items: [] };

const RESTORE: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: null,
  activeHostId: null,
  activeTurnStatus: null,
  localSnapshotsClearedAt: null,
  restore: null,
  restoreActionPending: false,
  restoreCheckpoint: () => null,
  accumulatedFileChanges: [],
  undeliveredChangeCount: 0,
  accumulatedSetComplete: true,
  revertFileChanges: () => null,
};

function renderDock(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactStripProvider
        value={{
          chips: [CHIP],
          openSection: null,
          panelId: "dock-panel-1",
          onToggle: () => undefined,
        }}
      >
        <ChatLowerDock
          snapshotLoaded={false}
          epicId="epic-1"
          chatId="chat-1"
          viewTabId="tab-1"
          selfAgent={null}
          activeAgents={[]}
          todo={null}
          restore={RESTORE}
          queue={EMPTY_QUEUE}
          folded={new Set(DOCK_SECTIONS)}
          dockOrder={[]}
          hotspots={{
            filesChanged: NO_HOTSPOT,
            activeAgents: NO_HOTSPOT,
            background: NO_HOTSPOT,
            todo: NO_HOTSPOT,
          }}
          backgroundItems={[]}
          runningManagedCommandCount={0}
          portForwardCount={0}
          heldManagedCommandCount={0}
          backgroundStopPendingTaskIds={new Set()}
          backgroundStopAllPending={false}
          backgroundSessionStopPending={false}
          activeTurnStatus={null}
          canAct={false}
          queueResumeRequested={false}
          queueKeepPausedRequested={false}
          readOnly
          editingQueueItemId={null}
          topSpacing="normal"
          scrollRegionMaxHeightClass="max-h-96"
          onQueuePause={() => null}
          onQueueResume={() => null}
          onQueueEdit={() => undefined}
          onQueueCancel={() => undefined}
          onQueueAbortSteer={() => undefined}
          onQueueReorder={() => undefined}
          onQueueSteerNow={() => undefined}
          onBackgroundItemClick={() => undefined}
          onBackgroundItemStop={() => null}
          onBackgroundItemsStopAll={() => null}
          onBackgroundSessionStop={() => null}
        />
      </ChatDockCompactStripProvider>
    </TooltipProvider>,
  );
}

function renderToolbar(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <ComposerTileIdProvider tileId={TILE}>
        <ComposerToolbar
          presentation
          store={createComposerToolbarStore({
            purpose: "run",
            reasoningFallback: "model-default",
            seedKey: TILE,
            values: {
              permission: "supervised",
              selection: {
                harnessId: "claude",
                modelSlug: "sample-model",
                profileId: null,
              },
              reasoning: "medium",
              serviceTier: "",
            },
            onSettingsChange: null,
            tuiOnly: false,
            chatLineCarriesAutoMode: null,
            hostId: null,
          })}
          onAttachImages={() => undefined}
          canSubmit={false}
          attachmentPending={false}
          onSubmit={() => undefined}
          activeTurnStatus={null}
          stopDisabled
          onStopTurn={null}
          composerDisabledHint={null}
          dictation={null}
          dictationPreparing={null}
          settingsLocked
          createProfileHostId={null}
          runTargetHostId={null}
          terminalLoginSurface={null}
          chatLineCarriesAutoMode={null}
        />
      </ComposerTileIdProvider>
    </TooltipProvider>,
  );
}

function renderComposerFoot(): void {
  render(
    <ComposerWorkspaceRow
      workspaceControls={<span data-testid="foot-control">Workspace</span>}
    />,
  );
}

/** The element each host's frame is a copy of, once the surface is mounted. */
function surfaceContainer(host: HostContextId): HTMLElement {
  const found = resolveSurface(host);
  if (found === null) throw new Error(`no real container for ${host}`);
  return found;
}

function resolveSurface(host: HostContextId): HTMLElement | null {
  const clusters = [
    ...document.querySelectorAll<HTMLElement>(`[${LAYOUT_CLUSTER_ATTRIBUTE}]`),
  ];
  switch (host) {
    case "toolbar":
      // The composer's left cluster, whose classes the right one shares.
      return clusters[0] ?? null;
    case "chip-strip":
      return document.querySelector<HTMLElement>(
        '[data-testid="chat-dock-compact-strip"]',
      );
    case "dock": {
      // The joined frame is the dock's own cluster box - the strip above it is
      // the other one, and it is matched by its test id above.
      const strip = document.querySelector(
        '[data-testid="chat-dock-compact-strip"]',
      );
      return clusters.find((cluster) => cluster !== strip) ?? null;
    }
    case "composer-foot": {
      const control = document.querySelector('[data-testid="foot-control"]');
      return control?.parentElement ?? null;
    }
    default:
      return null;
  }
}

const RENDERED: Readonly<Partial<Record<HostContextId, () => void>>> = {
  toolbar: renderToolbar,
  "chip-strip": renderDock,
  dock: renderDock,
  "composer-foot": renderComposerFoot,
};

beforeEach(() => {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
});

describe("every host context is accounted for", () => {
  it("either renders its real surface here or states why not", () => {
    for (const host of ALL_HOSTS) {
      const covered =
        RENDERED[host] !== undefined ||
        NO_RENDERABLE_SURFACE[host] !== undefined;
      expect(covered, host).toBe(true);
      // Never both: an excuse beside a mount is a record that says two things.
      expect(
        RENDERED[host] !== undefined &&
          NO_RENDERABLE_SURFACE[host] !== undefined,
        host,
      ).toBe(false);
    }
  });
});

const RENDERABLE_HOSTS: ReadonlyArray<HostContextId> = ALL_HOSTS.filter(
  (host) => RENDERED[host] !== undefined,
);

describe("a host frame is a copy of its real surface", () => {
  it.each(RENDERABLE_HOSTS)(
    "%s carries the surface's own paint and spacing",
    (host) => {
      RENDERED[host]?.();
      const real = [...surfaceContainer(host).classList].filter(isSurfaceClass);
      const frame = frameClasses(host);
      // A surface with no class in any of these families would make the claim
      // vacuous, which is how a renamed container silently stops being
      // compared at all.
      expect(real.length, host).toBeGreaterThan(0);
      for (const className of real) {
        expect([...frame], className).toContain(className);
      }
    },
  );

  it.each(RENDERABLE_HOSTS)("%s invents no type scale of its own", (host) => {
    const chrome = frameChrome();
    cleanup();
    RENDERED[host]?.();
    const real = new Set(
      [...surfaceContainer(host).classList].filter(isTypeScaleClass),
    );
    const invented = [...frameClasses(host)]
      .filter((className) => !chrome.has(className))
      .filter(isTypeScaleClass)
      .filter((className) => !real.has(className));
    expect(invented, host).toEqual([]);
  });
});
