import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { SwitcherPrPresenceProbe } from "@/components/epic-canvas/mobile/switcher-pr-presence-probe";
import {
  prPresenceScopeKey,
  selectPrScopeHasItems,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";

const EPIC_ID = "epic-probe";
const HOST_ID = "host-A";

interface SubscriptionArgs {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly mode: string;
  readonly enabled: boolean;
}

// The WS transport is the external boundary; fake it so the probe's own
// contract - what it subscribes and what it writes - stays observable.
const subscriptionState = vi.hoisted(
  (): {
    items: readonly PrLightItem[] | null;
    methodSupport: string;
    lastArgs: SubscriptionArgs | null;
  } => ({
    items: null,
    methodSupport: "supported",
    lastArgs: null,
  }),
);
vi.mock("@/hooks/pr/use-pr-list-subscription", () => ({
  usePrListSubscription: (args: SubscriptionArgs) => {
    subscriptionState.lastArgs = args;
    return {
      data:
        subscriptionState.items === null
          ? null
          : {
              sourceStatus: "ok",
              notice: null,
              items: subscriptionState.items,
            },
      error: null,
      isPending: false,
      sendRefresh: () => undefined,
    };
  },
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => subscriptionState.methodSupport,
}));

function buildPrItem(): PrLightItem {
  return {
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: null,
    state: "open",
    liveness: "live",
    observedAt: null,
    isDraft: false,
    title: "Add the mobile switcher",
    baseRefName: "main",
    headRefName: "feature/switcher",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    commentCount: 0,
    updatedAt: 1_000,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
  };
}

/** What the switcher would read - "not recorded" and `false` both mean no PRs. */
function presenceForEpic(): boolean {
  return selectPrScopeHasItems(HOST_ID, EPIC_ID)(usePrPresenceStore.getState());
}

function isPresenceRecorded(): boolean {
  const key = prPresenceScopeKey(HOST_ID, EPIC_ID);
  return Object.hasOwn(usePrPresenceStore.getState().hasItemsByScopeKey, key);
}

function renderProbe(hostId: string | null) {
  return render(<SwitcherPrPresenceProbe epicId={EPIC_ID} hostId={hostId} />);
}

describe("<SwitcherPrPresenceProbe />", () => {
  beforeEach(() => {
    subscriptionState.items = null;
    subscriptionState.methodSupport = "supported";
    subscriptionState.lastArgs = null;
    usePrPresenceStore.setState({ hasItemsByScopeKey: {} });
  });
  afterEach(cleanup);

  it("subscribes the epic's PR list in the panel's own mode, so the two share one session", () => {
    renderProbe(HOST_ID);
    expect(subscriptionState.lastArgs).toMatchObject({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      mode: "foreground",
      enabled: true,
    });
  });

  it("records presence when the epic has PRs", () => {
    subscriptionState.items = [buildPrItem()];
    renderProbe(HOST_ID);
    expect(presenceForEpic()).toBe(true);
  });

  it("clears a stale presence when the list frame comes back empty", () => {
    usePrPresenceStore.setState({
      hasItemsByScopeKey: { [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true },
    });
    subscriptionState.items = [];
    renderProbe(HOST_ID);
    expect(presenceForEpic()).toBe(false);
  });

  it("writes nothing before the first frame lands", () => {
    // `null` is "no frame yet", NOT "no PRs" - writing `false` here would blank
    // a known-good signal every time the sheet opens.
    usePrPresenceStore.setState({
      hasItemsByScopeKey: { [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true },
    });
    renderProbe(HOST_ID);
    expect(presenceForEpic()).toBe(true);
  });

  it("writes nothing when no host is resolved", () => {
    subscriptionState.items = [buildPrItem()];
    renderProbe(null);
    expect(isPresenceRecorded()).toBe(false);
    expect(usePrPresenceStore.getState().hasItemsByScopeKey).toEqual({});
  });

  it("stays disabled against a host that does not advertise the stream", () => {
    subscriptionState.methodSupport = "unsupported";
    renderProbe(HOST_ID);
    expect(subscriptionState.lastArgs?.enabled).toBe(false);
  });

  it("renders nothing", () => {
    const { container } = renderProbe(HOST_ID);
    expect(container.innerHTML).toBe("");
  });
});
