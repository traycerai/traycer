import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type ProvidersFallbackPolicyGetResponse,
  type ProvidersFallbackPolicyPreviewTierGroupsResponse,
  type TierCandidatePreview,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";

/**
 * The per-row "resolves to" verdicts (ticket 08, clause 4).
 *
 * Separate from `fallback-settings-panel.test.tsx`, which makes the preview hook
 * inert: this suite's whole subject is what that hook's answer renders, so it
 * needs its own module mock rather than a mutable flag threaded through the
 * other one.
 *
 * The hook is mocked at its own boundary, so the panel's GATE is bypassed for
 * the rendering tests below - a mocked hook returns rows whatever it is asked.
 * The gate is asserted separately, by capturing the ARGUMENT the panel passes,
 * which is the only part of it that lives in the panel at all.
 */
const { WORK_PROFILE_ID, HOME_PROFILE_ID, ORPHAN_PROFILE_ID } = vi.hoisted(
  () => ({
    WORK_PROFILE_ID: "3f2a9c1e-7b44-4d02-9f18-6c5a1e30b7d9",
    HOME_PROFILE_ID: "8b71d0a4-2e19-45c7-bd63-91af02c4e8aa",
    // Never listed: stands for a profile deleted since the walk resolved it.
    ORPHAN_PROFILE_ID: "c41e77b2-9a05-4f38-8d1c-27be6a90f3e4",
  }),
);

const previewMocks = vi.hoisted(
  (): {
    queryData: ProvidersFallbackPolicyGetResponse | undefined;
    previewData: ProvidersFallbackPolicyPreviewTierGroupsResponse | undefined;
    previewSpy: Mock<(groups: readonly TierGroup[] | null) => void>;
  } => ({
    queryData: undefined,
    previewData: undefined,
    previewSpy: vi.fn(),
  }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const host = hostScopeOptionFixture({ hostId: "host-a", name: "Test Host" });
  return {
    useHostScope: () =>
      hostScopeFixture({
        hosts: [host],
        host,
        hostId: host.hostId,
        hostLabel: host.name,
        activeHost: host,
        isViewingActive: true,
        status: "following",
        client: null,
      }),
  };
});

vi.mock("@/hooks/providers/use-fallback-policy-query", () => ({
  useFallbackPolicyQuery: () => ({
    isError: false,
    data: previewMocks.queryData,
  }),
}));

vi.mock("@/hooks/providers/use-fallback-policy-set-mutation", () => ({
  useFallbackPolicySetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/providers/use-fallback-policy-reset-mutation", () => ({
  useFallbackPolicyResetMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation",
  () => ({
    useFallbackPolicyRestoreTierGroupsMutation: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }),
);

// The subject. `previewSpy` records the argument so the panel's own gate can be
// asserted without reaching into the hook's internals.
vi.mock(
  "@/hooks/providers/use-fallback-policy-preview-tier-groups-query",
  () => ({
    useFallbackPolicyPreviewTierGroupsQuery: (
      groups: readonly TierGroup[] | null,
    ) => {
      previewMocks.previewSpy(groups);
      return { data: previewMocks.previewData, isFetching: false };
    },
  }),
);

// Real data, not `{ data: undefined }`: the label resolver under test builds
// its map from THIS read, so an empty one would make every id degrade to its
// prefix and the pin below would pass without the rule ever running.
// The Effort control's catalog read is out of this suite's scope, and
// `useFallbackEffortOptions` calls `useHostClient()`, which throws outside a
// `<HostRuntimeProvider>` (`src/lib/host/runtime.ts:125`). Zero options is the
// documented "no answer" state that keeps the free-text Effort input, which is
// what this suite's assertions already expect - none of them touches Effort.
vi.mock(
  "@/components/settings/panels/fallback/fallback-effort-options",
  () => ({
    useFallbackEffortOptions: () => () => [],
  }),
);

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: {
      providers: [
        {
          providerId: "claude",
          profiles: [
            { profileId: WORK_PROFILE_ID, label: "Work", kind: "managed" },
            { profileId: HOME_PROFILE_ID, label: "Home", kind: "managed" },
          ],
        },
      ],
    },
  }),
}));

import { FallbackSettingsPanel } from "@/components/settings/panels/fallback-settings-panel";

const GROUP_ID = "frontier";

function candidate(modelFamily: string): TierGroup["candidates"][number] {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

/**
 * Four rows in one group, chosen so the tone rule has something to be wrong
 * about in both directions: one that resolved, one the user authored badly, one
 * that failed for an environmental reason, and one whose reason this client has
 * never heard of.
 */
const GROUPS: TierGroup[] = [
  {
    id: GROUP_ID,
    candidates: [
      candidate("opus"),
      candidate("ghost"),
      candidate("sonnet"),
      candidate("nova"),
    ],
  },
];

// `candidateIndex` is a separate parameter rather than a required member of an
// otherwise-`Partial` overrides object: the intersection compiles, but the
// spread's result type is where it would stop being obviously required, and a
// preview row with the wrong index pairs silently with another row.
function previewRow(
  candidateIndex: number,
  overrides: Partial<TierCandidatePreview>,
): TierCandidatePreview {
  return {
    groupId: GROUP_ID,
    candidateIndex,
    harnessId: "claude",
    modelFamily: "opus",
    reasoningEffort: null,
    resolvedModel: null,
    profileId: null,
    skipReason: null,
    skipLabel: null,
    warnings: [],
    ...overrides,
  };
}

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    enabled: true,
    tierGroups: GROUPS,
    ...overrides,
  };
}

function respond(
  policyValue: FallbackPolicy,
): ProvidersFallbackPolicyGetResponse {
  return {
    policy: policyValue,
    storedPolicyUnreadable: false,
    inFlightCount: 0,
  };
}

function renderPanel() {
  return render(
    <StrictMode>
      <FallbackSettingsPanel />
    </StrictMode>,
  );
}

function previewLines(): HTMLElement[] {
  return screen.queryAllByTestId("fallback-tier-candidate-preview");
}

beforeEach(() => {
  previewMocks.queryData = respond(policy({}));
  previewMocks.previewData = undefined;
  previewMocks.previewSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FallbackSettingsPanel - per-row preview verdicts render from the host's words", () => {
  it("prints one line per candidate, taking `skipLabel` verbatim - including for a reason this client cannot parse", () => {
    previewMocks.previewData = {
      candidates: [
        previewRow(0, {
          modelFamily: "opus",
          resolvedModel: "claude-opus-5",
          profileId: WORK_PROFILE_ID,
        }),
        previewRow(1, {
          modelFamily: "ghost",
          skipReason: "family-unmatched",
          skipLabel: "No model matches this family",
        }),
        previewRow(2, {
          modelFamily: "sonnet",
          // A real member of `TIER_RUNG_SKIP_REASONS`, deliberately. An
          // invented code would fail the schema and fall into the same branch
          // as the row below, so the two rows would prove one property twice
          // instead of separating "recognised, but not the user's fault" from
          // "this client has never heard of it".
          skipReason: "provider-unavailable",
          skipLabel: "Claude is unavailable",
        }),
        previewRow(3, {
          modelFamily: "nova",
          // A reason string this client's schema does not contain. The wire
          // field is deliberately open (`z.string()`), and the rule it exists
          // for is that the LABEL still prints - a released client meeting a
          // newer host must show a sentence, never a blank row.
          skipReason: "a-reason-from-a-newer-host",
          skipLabel: "Held back by the provider",
        }),
      ],
    };
    renderPanel();

    const lines = previewLines();
    expect(lines).toHaveLength(4);
    expect(lines[0].textContent).toContain("resolves to");
    expect(lines[0].textContent).toContain("claude-opus-5");
    expect(lines[0].textContent).toContain("on Work");
    expect(lines[1].textContent).toContain("No model matches this family");
    expect(lines[2].textContent).toContain("Claude is unavailable");
    expect(lines[3].textContent).toContain("Held back by the provider");
  });

  it("colours ONLY `family-unmatched` red, and the three that stay muted are what make that assertion mean something", () => {
    previewMocks.previewData = {
      candidates: [
        previewRow(0, {
          resolvedModel: "claude-opus-5",
        }),
        previewRow(1, {
          skipReason: "family-unmatched",
          skipLabel: "No model matches this family",
        }),
        previewRow(2, {
          skipReason: "provider-unavailable",
          skipLabel: "Claude is unavailable",
        }),
        previewRow(3, {
          skipReason: "a-reason-from-a-newer-host",
          skipLabel: "Held back by the provider",
        }),
      ],
    };
    renderPanel();

    const lines = previewLines();
    // The positive control is inside the same render rather than in a second
    // test: three rows that must NOT be red sit beside the one that must. A
    // rule that reddened everything, or nothing, fails here - which a
    // single-row fixture could not distinguish.
    const red = lines.filter(
      (line) => line.getAttribute("data-unmatched") === "true",
    );
    expect(red).toHaveLength(1);
    expect(red[0].textContent).toContain("No model matches this family");
    expect(lines[0].getAttribute("data-unmatched")).toBeNull();
    expect(lines[2].getAttribute("data-unmatched")).toBeNull();
    // The unknown reason is muted too, and deliberately: an unparseable reason
    // is not evidence that the user authored the row wrong.
    expect(lines[3].getAttribute("data-unmatched")).toBeNull();
  });

  it("renders no verdict line at all when the host has no answer", () => {
    previewMocks.previewData = undefined;
    renderPanel();
    // Absence, not a client-side guess. Falsification: make the panel pass
    // anything but `null` to the editor when `data` is undefined - a `[]`, a
    // placeholder row - and this assertion must go red. The fixture reaches
    // this state through the ordinary path (an older host, or a read that has
    // not landed), not through an error branch: `queryData` above is a normal
    // successful policy read.
    expect(previewLines()).toHaveLength(0);
    // ... while the rows themselves are on screen, so the emptiness above is
    // the verdict lines' own and not a panel that failed to render.
    expect(screen.getAllByLabelText("Model family")).toHaveLength(4);
  });

  it("names the ACCOUNT, never its id - D190", () => {
    previewMocks.previewData = {
      candidates: [
        previewRow(0, {
          resolvedModel: "claude-opus-5",
          profileId: WORK_PROFILE_ID,
        }),
        // Not in the providers list - a profile deleted since the walk resolved
        // it. The host's own rule (D118) degrades to a short prefix rather than
        // dropping the clause, because a card describing an account still has to
        // name it.
        previewRow(1, {
          resolvedModel: "claude-sonnet-5",
          profileId: ORPHAN_PROFILE_ID,
        }),
        // No account to report at all. Distinct from the chat cards, where
        // `null` means a terminal agent and is NAMED "Terminal account"; here
        // the clause is omitted.
        previewRow(2, { resolvedModel: "claude-haiku-5", profileId: null }),
      ],
    };
    renderPanel();

    const lines = previewLines();
    expect(lines[0].textContent).toContain("on Work");
    // The assertion the finding is actually about: the uuid must not be on
    // screen anywhere in that row.
    expect(lines[0].textContent).not.toContain(WORK_PROFILE_ID);

    // Positive control: an id the list cannot resolve DOES still print, as its
    // 8-character prefix. Without this the pin above would pass on a panel that
    // had simply stopped rendering the clause at all.
    expect(lines[1].textContent).toContain(ORPHAN_PROFILE_ID.slice(0, 8));
    expect(lines[1].textContent).not.toContain(ORPHAN_PROFILE_ID);

    // And `null` keeps the clause off rather than naming anything.
    expect(lines[2].textContent).toContain("claude-haiku-5");
    expect(lines[2].textContent).not.toContain(" on ");
  });

  it("disambiguates two accounts that share a label, the way the host does", () => {
    previewMocks.previewData = {
      candidates: [
        previewRow(0, {
          resolvedModel: "claude-opus-5",
          profileId: WORK_PROFILE_ID,
        }),
      ],
    };
    renderPanel();
    // "Work" and "Home" are distinct here, so the plain label is what shows -
    // the control for the shared-label branch, which appends a bracketed prefix.
    // Stated as an equality on the rendered clause rather than a `toContain`, so
    // a resolver that appended a suffix regardless would fail.
    expect(previewLines()[0].textContent).toContain("on Work");
    expect(previewLines()[0].textContent).not.toContain("[");
  });

  it("asks only while the groups on screen are the groups the host has", () => {
    renderPanel();
    // Committed on first render: the draft came straight from the read.
    expect(previewMocks.previewSpy).toHaveBeenLastCalledWith(GROUPS);

    // A keystroke that has not been committed (no blur, no Enter) moves the
    // draft away from the persisted groups. The panel must stop asking: the
    // verdicts pair to rows by position, so an answer computed for a list that
    // is not on screen would put one model's verdict under another.
    fireEvent.change(screen.getAllByLabelText("Model family")[0], {
      target: { value: "opu" },
    });
    expect(previewMocks.previewSpy).toHaveBeenLastCalledWith(null);
  });
});
