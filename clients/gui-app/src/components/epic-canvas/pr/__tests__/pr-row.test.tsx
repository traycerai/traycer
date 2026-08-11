import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { PrRow, type PrRowEntry } from "@/components/epic-canvas/pr/pr-row";
import { makePrDetailTile, prDetailTileId } from "@/lib/pr/pr-detail-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  PR_STATE_PILL_CLASS,
  PR_STATE_TINT_CLASS,
} from "@/components/worktree/worktree-pr-state-palette";
import {
  compositeOverBackground,
  contrastRatio,
  DARK_THEME_SURFACES,
  LIGHT_THEME_SURFACES,
} from "../../../../../__tests__/contrast";

// The owner badges read the per-Epic Y.doc projection and the tile-navigation
// stack, which need a live `OpenEpicStoreHandle` this presentational test has
// no use for. Stubbed to a minimal badge per owner so the row's OWN wiring
// (which owners it passes down, and to which epic) stays observable.
vi.mock("@/components/epic-canvas/pr/pr-owner-label", () => ({
  PrOwnerBadges: (props: {
    readonly owners: readonly { readonly ownerId: string }[];
    readonly epicId: string;
  }) =>
    props.owners.length === 0 ? null : (
      <span data-testid="pr-owner-badges" data-epic-id={props.epicId}>
        {props.owners.map((owner) => (
          <span key={owner.ownerId} data-testid="pr-owner-badge">
            {owner.ownerId}
          </span>
        ))}
      </span>
    ),
}));

const BASE_ITEM: PrLightItem = {
  githubHost: "github.com",
  base: { owner: "traycerai", repo: "traycer-internal", prNumber: 4226 },
  prUrl: "https://github.com/traycerai/traycer-internal/pull/4226",
  state: "open",
  liveness: "live",
  observedAt: 1_000,
  isDraft: false,
  title: "Remote Host Support",
  baseRefName: "development",
  headRefName: "traycer/remote-host-support",
  additions: 10,
  deletions: 2,
  checksRollup: null,
  reviewDecision: null,
  commentCount: 0,
  updatedAt: null,
  repoIdentifier: { owner: "traycerai", repo: "traycer-internal" },
  repoRole: "superproject",
  linkGroupKey: null,
  owners: [],
};

const ROW_TILE_COORDS = {
  hostId: "host1",
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer-internal",
  prNumber: 4226,
};
const LINKED_TILE_COORDS = {
  ...ROW_TILE_COORDS,
  repo: "traycer",
  prNumber: 675,
};
const ROW_TILE_ID = prDetailTileId(ROW_TILE_COORDS);
const LINKED_TILE_ID = prDetailTileId(LINKED_TILE_COORDS);
const TAB_ID = "tab-with-no-canvas";

function entry(
  overrides: Partial<PrLightItem>,
  onOpen: (() => void) | null,
): PrRowEntry {
  return {
    key: "row",
    item: { ...BASE_ITEM, ...overrides },
    tileId: ROW_TILE_ID,
    onOpen,
  };
}

function renderRow(overrides: Partial<PrLightItem>) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>
        <PrRow
          entry={entry(overrides, () => {})}
          epicId="epic-1"
          tabId={TAB_ID}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/** As {@link renderRow}, but with a RunnerHost bound so the bridge is live. */
function renderRowWithRunnerHost(runnerHost: MockRunnerHost) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <RunnerHostContext.Provider value={runnerHost}>
        <TooltipProvider>
          <PrRow entry={entry({}, () => {})} epicId="epic-1" tabId={TAB_ID} />
        </TooltipProvider>
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("PrRow band 1: identity badges", () => {
  it("carries state on the number badge rather than a separate state pill", () => {
    renderRow({ state: "merged" });

    const number = screen.getByTestId("pr-row-number");
    expect(number.getAttribute("data-pr-state")).toBe("merged");
    expect(number.textContent).toContain("#4226");
    expect(screen.getByTestId("pr-row-state-glyph")).toBeTruthy();
  });

  it("makes the number badge itself the GitHub link", () => {
    renderRow({});

    const link = screen.getByRole("link", { name: "Open #4226 on GitHub" });
    expect(link).toBe(screen.getByTestId("pr-row-number"));
    expect(link.getAttribute("href")).toBe(
      "https://github.com/traycerai/traycer-internal/pull/4226",
    );
  });

  it("keeps the number badge a plain badge when there is no PR url to open", () => {
    renderRow({ prUrl: null });

    expect(
      screen.queryByRole("link", { name: "Open #4226 on GitHub" }),
    ).toBeNull();
    expect(screen.getByTestId("pr-row-number").tagName).not.toBe("A");
  });

  it("drops a second badge click fired while the first bridge request is in flight", async () => {
    // `mutate` fires a fresh RunnerHost request per call, so an unguarded
    // double click opens the user's browser twice. Same guard, same reason, as
    // `PrDetailGitHubLink` and `PrExternalGitHubLink`.
    const host = createRunnerHost();
    let resolveOpen: (() => void) | undefined;
    const openExternalLink = vi
      .spyOn(host, "openExternalLink")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveOpen = resolve;
          }),
      );
    renderRowWithRunnerHost(host);

    const badge = screen.getByTestId("pr-row-number");
    fireEvent.click(badge);

    // Wait until the first request is genuinely in flight (`isPending` true)
    // before the second click, so its handler closure observes the pending
    // mutation rather than racing the first dispatch.
    await waitFor(() => {
      expect(openExternalLink).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(badge);

    // `mutate` dispatches through a microtask, so a second, unwanted call
    // would not appear in a synchronous assertion - flush first.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(openExternalLink).toHaveBeenCalledTimes(1);
    expect(openExternalLink).toHaveBeenCalledWith(
      "https://github.com/traycerai/traycer-internal/pull/4226",
    );

    resolveOpen?.();
  });
});

describe("PrRow band 2-4: title, branches, owners", () => {
  it("keeps the PR number out of the title so the title gets the full width", () => {
    renderRow({});

    expect(screen.getByTestId("pr-row-title").textContent).toBe(
      "Remote Host Support",
    );
    expect(screen.getByTestId("pr-row").textContent).toContain("#4226");
  });

  it("reads the branch line as a merge target - base first", () => {
    renderRow({});

    expect(screen.getByTestId("pr-row").textContent).toContain(
      "development ← traycer/remote-host-support",
    );
  });

  it("hands every owner to the badge row, scoped to this epic", () => {
    renderRow({
      owners: [
        { ownerId: "chat-1", ownerKind: "chat" },
        { ownerId: "agent-1", ownerKind: "terminal-agent" },
      ],
    });

    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(2);
    expect(
      screen.getByTestId("pr-owner-badges").getAttribute("data-epic-id"),
    ).toBe("epic-1");
  });

  it("still labels the row with the full title for assistive tech", () => {
    renderRow({});

    expect(
      screen.getByLabelText("Open #4226 · Remote Host Support"),
    ).toBeTruthy();
  });

  // A never-swept row has `title: null`. The element used to render anyway, so
  // the card read as "number badge, blank line, branch" - reported as the PR
  // summary going missing. The identity already lives in the number badge, so
  // the row drops the element rather than leaving a gap where a title was.
  it("renders no title element at all when the PR has no observed title", () => {
    renderRow({ title: null });

    expect(screen.queryByTestId("pr-row-title")).toBeNull();
  });

  it("keeps the identity and branch readable on a row with no title", () => {
    renderRow({ title: null });

    // The row still says WHICH PR it is - dropping the title must not drop the
    // row's identity with it.
    expect(screen.getByTestId("pr-row").textContent).toContain("#4226");
    expect(screen.getByTestId("pr-row").textContent).toContain(
      "development ← traycer/remote-host-support",
    );
  });

  it("renders the title element whenever a title was observed", () => {
    renderRow({});

    // The guard is conditional on the title, not on something incidental that
    // happens to be set on this fixture.
    expect(screen.getByTestId("pr-row-title").textContent).toBe(
      "Remote Host Support",
    );
  });
});

describe("PrRow status badges", () => {
  it("rolls CI up to one worst-wins chip instead of three bare counters", () => {
    renderRow({
      checksRollup: { success: 10, failure: 1, pending: 3, total: 14 },
    });

    const checks = screen.getByTestId("pr-row-checks");
    expect(checks.getAttribute("data-tone")).toBe("fail");
    expect(checks.textContent).toContain("1 failing");
    // The counters that used to sit inline are gone from the row surface.
    expect(checks.textContent).not.toContain("passed");
    expect(checks.textContent).not.toContain("running");
  });

  it("labels the review decision rather than repeating the checks glyph", () => {
    renderRow({ reviewDecision: "changes_requested" });

    expect(screen.getByTestId("pr-row-review").textContent).toContain(
      "Changes requested",
    );
  });

  // jsdom does not evaluate container queries, so the drop ORDER is asserted
  // through the classes that encode it: the review badge (longest label) must
  // go at a wider breakpoint than the checks badge, and the number badge - the
  // row's identity and its state - must carry no drop rule at all.
  it("sheds in priority order: review, then checks - never the number or the comment count", () => {
    renderRow({
      reviewDecision: "changes_requested",
      checksRollup: { success: 0, failure: 1, pending: 0, total: 1 },
      commentCount: 2,
    });

    // The comment count stays at every width: blinking out mid-drag reads as a
    // glitch, and it is far cheaper than a badge.
    expect(screen.getByTestId("pr-row-comments").className).not.toContain(
      ":hidden",
    );
    expect(screen.getByTestId("pr-row-review").className).toContain(
      "@max-[17rem]:hidden",
    );
    expect(screen.getByTestId("pr-row-checks").className).toContain(
      "@max-[13rem]:hidden",
    );
    expect(screen.getByTestId("pr-row-number").className).not.toContain(
      ":hidden",
    );
  });

  it("lets the longest badge truncate before it is dropped", () => {
    renderRow({ reviewDecision: "changes_requested" });

    const review = screen.getByTestId("pr-row-review");
    expect(review.className).toContain("shrink");
    expect(review.className).not.toContain("shrink-0");
    expect(review.querySelector(".truncate")).not.toBeNull();
  });

  // The reported bug: at a width past the review badge's drop point but above
  // the checks badge's own, "1 running" kept its full width and painted over
  // the comment count and timestamp. Those are pinned right and `shrink-0` by
  // design, and the column holding the badges is `min-w-0` with overflow
  // visible - so anything in it that cannot shrink overflows ONTO them rather
  // than pushing them. Every badge in that column except the identity one has
  // to be able to give width back.
  it("lets the checks badge shrink instead of overflowing onto the trailing slot", () => {
    renderRow({
      checksRollup: { success: 0, failure: 0, pending: 1, total: 1 },
      commentCount: 4,
    });

    const checks = screen.getByTestId("pr-row-checks");
    expect(checks.className).toContain("shrink");
    expect(checks.className).not.toContain("shrink-0");
    expect(checks.className).toContain("min-w-0");
    // `shrink` alone only makes the BOX narrower - without a truncating child
    // the label still spills out of it.
    expect(checks.querySelector(".truncate")).not.toBeNull();
  });

  it("shows no CI or review badge when a PR has neither", () => {
    renderRow({});

    expect(screen.queryByTestId("pr-row-checks")).toBeNull();
    expect(screen.queryByTestId("pr-row-review")).toBeNull();
  });
});

describe("PrRow activity metadata", () => {
  it("keeps the comment count out of the CI badges", () => {
    renderRow({ commentCount: 2 });

    const comments = screen.getByTestId("pr-row-comments");
    expect(comments.textContent).toContain("2");
    expect(screen.queryByTestId("pr-row-checks")).toBeNull();
  });

  it("hides a zero comment count", () => {
    renderRow({ commentCount: 0 });

    expect(screen.queryByTestId("pr-row-comments")).toBeNull();
  });

  it("marks a cache-only row as not live", () => {
    renderRow({ liveness: "cache-only" });

    expect(screen.getByTestId("pr-row-not-live")).toBeTruthy();
  });

  it("renders no owner badges for a PR no chat owns", () => {
    renderRow({});

    expect(screen.queryByTestId("pr-owner-badges")).toBeNull();
  });
});

describe("PrRow submodule PRs", () => {
  it("renders a submodule PR with the same full row as any other PR", () => {
    // No compact child variant any more: a submodule PR is its own review, so
    // it gets the same four bands - and it reaches the row through its own
    // repo group (see `groupPrItemsByRepo`), not as somebody's nested detail.
    renderRow({
      base: { owner: "traycerai", repo: "traycer", prNumber: 675 },
      prUrl: "https://github.com/traycerai/traycer/pull/675",
      repoIdentifier: { owner: "traycerai", repo: "traycer" },
      repoRole: "submodule",
      linkGroupKey: "/w/pair",
      title: "Protocol bits",
      baseRefName: "main",
    });

    expect(screen.getByTestId("pr-row-number").textContent).toContain("#675");
    expect(screen.getByTestId("pr-row-title").textContent).toBe(
      "Protocol bits",
    );
    expect(screen.getByTestId("pr-row").textContent).toContain("main");
    expect(screen.queryByTestId("pr-linked-row")).toBeNull();
    expect(screen.queryByTestId("pr-row-linked")).toBeNull();
  });
});

describe("PrRow selection surface", () => {
  // The shared PR palette's contrast numbers are computed against a state tint
  // composited over a THEME SURFACE. Selection changes that surface, so what
  // selection paints has to be re-checked against the same floor.
  //
  // The first attempt was a solid `bg-accent` fill, copied from the one-line
  // chat row. Measured, it is not a WCAG failure - it bottoms out at 3.08:1 on
  // `traycer-green` dark, whose `--accent` is its saturated `--primary`
  // (#257174) - but that is the 3:1 graphic floor with nothing to spare, on a
  // row whose whole job is carrying status colour. The wash restores the
  // margin; these two tests pin both halves of that.
  const ROW_ACCENT_ALPHA = 0.35;
  const TINT_ALPHA = 0.1;
  const STATE_TONES = [
    { state: "open", tint: "#22c55e", light: "#166534", dark: "#86efac" },
    { state: "closed", tint: "#ef4444", light: "#991b1b", dark: "#fca5a5" },
    { state: "merged", tint: "#a855f7", light: "#6b21a8", dark: "#d8b4fe" },
  ] as const;

  function worstRatio(accentAlpha: number): number {
    const ratios = STATE_TONES.flatMap(({ tint, light, dark }) => [
      ...Object.values(LIGHT_THEME_SURFACES).map((surfaces) =>
        contrastRatio(
          light,
          compositeOverBackground(
            tint,
            TINT_ALPHA,
            compositeOverBackground(
              surfaces.accent,
              accentAlpha,
              surfaces.background,
            ),
          ),
        ),
      ),
      ...Object.values(DARK_THEME_SURFACES).map((surfaces) =>
        contrastRatio(
          dark,
          compositeOverBackground(
            tint,
            TINT_ALPHA,
            compositeOverBackground(
              surfaces.accent,
              accentAlpha,
              surfaces.background,
            ),
          ),
        ),
      ),
    ]);
    return Math.min(...ratios);
  }

  it.each(STATE_TONES)(
    "keeps the $state row's state glyph clear of the graphic floor while selected, on every preset",
    ({ state, tint, light, dark }) => {
      // Pin the tokens these ratios stand for: if the palette moves off these
      // ramps the numbers stop describing what ships.
      expect(PR_STATE_TINT_CLASS[state]).toContain("dark:text-");
      expect(PR_STATE_PILL_CLASS[state]).toContain("/10");

      const failures: string[] = [];
      for (const [preset, surfaces] of Object.entries(LIGHT_THEME_SURFACES)) {
        const ratio = contrastRatio(
          light,
          compositeOverBackground(
            tint,
            TINT_ALPHA,
            compositeOverBackground(
              surfaces.accent,
              ROW_ACCENT_ALPHA,
              surfaces.background,
            ),
          ),
        );
        if (ratio < 3) failures.push(`${preset} light: ${ratio.toFixed(2)}`);
      }
      for (const [preset, surfaces] of Object.entries(DARK_THEME_SURFACES)) {
        const ratio = contrastRatio(
          dark,
          compositeOverBackground(
            tint,
            TINT_ALPHA,
            compositeOverBackground(
              surfaces.accent,
              ROW_ACCENT_ALPHA,
              surfaces.background,
            ),
          ),
        );
        if (ratio < 3) failures.push(`${preset} dark: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    },
  );

  it("buys real margin over the solid fill it replaced", () => {
    // The reason the wash is not cosmetic bikeshedding, as a number: a solid
    // accent fill leaves the worst preset sitting on the 3:1 floor, the wash
    // lifts it clear. Guards against someone reading `/35` as noise and
    // "simplifying" it back to `bg-accent`.
    const solid = worstRatio(1);
    const wash = worstRatio(ROW_ACCENT_ALPHA);
    expect(solid).toBeLessThan(3.5);
    expect(wash).toBeGreaterThan(4);
    expect(wash).toBeGreaterThan(solid);
  });
});

describe("PrRow active-tile highlight", () => {
  const renderInTab = (tabId: string, tileId: string | null) =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TooltipProvider>
          <PrRow
            entry={{ key: "row", item: BASE_ITEM, tileId, onOpen: () => {} }}
            epicId="epic-1"
            tabId={tabId}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

  it("highlights the row whose detail tile is the one on screen", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic");
    store.openTileInTab(
      tabId,
      makePrDetailTile({ ...ROW_TILE_COORDS, name: "PR" }),
    );

    renderInTab(tabId, ROW_TILE_ID);

    expect(screen.getByTestId("pr-row").getAttribute("data-active")).toBe(
      "true",
    );
    expect(screen.getByTestId("pr-row-main").getAttribute("aria-current")).toBe(
      "true",
    );

    // Ties the "PrRow selection surface" matrix above to what actually ships:
    // that matrix is pure maths over the palette, so without this a revert to
    // the solid `bg-accent` fill would leave every contrast test still green.
    const tokens = screen.getByTestId("pr-row-main").className.split(/\s+/);
    expect(tokens).toContain("bg-accent/35");
    expect(tokens).not.toContain("bg-accent");
    expect(screen.getByTestId("pr-row-active-indicator")).not.toBeNull();
  });

  it("leaves every other PR's row unhighlighted", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic");
    store.openTileInTab(
      tabId,
      makePrDetailTile({ ...ROW_TILE_COORDS, name: "PR" }),
    );

    renderInTab(tabId, LINKED_TILE_ID);

    expect(screen.getByTestId("pr-row").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("never highlights an unknown-base row, which has no tile at all", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic");
    store.openTileInTab(
      tabId,
      makePrDetailTile({ ...ROW_TILE_COORDS, name: "PR" }),
    );

    renderInTab(tabId, null);

    expect(screen.getByTestId("pr-row").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("highlights nothing when the tab has no canvas yet", () => {
    renderInTab(TAB_ID, ROW_TILE_ID);

    expect(screen.getByTestId("pr-row").getAttribute("data-active")).toBe(
      "false",
    );
  });
});
