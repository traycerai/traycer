/**
 * The single visibility projection.
 *
 * Every surface that can show a role claim - `agent.roles.list`, overlap
 * detection, the `overlapping` payload handed back to a claimant, and the
 * role block rendered into an agent's system prompt - reads through
 * `projectVisibleRoleClaims` and adds no filtering of its own. So this is the
 * ONE place cross-account leakage could happen, which is why it is tested
 * against a two-user epic rather than a single-user one.
 *
 * An epic can hold several collaborators' agents. Cross-account role
 * organization is out of scope for v1, so another account's claims must not
 * surface anywhere - not in a list, and not smuggled in through an overlap
 * result or a prompt.
 */
import { describe, expect, it } from "vitest";
import {
  projectVisibleRoleClaims,
  type RoleClaim,
} from "@traycer/protocol/persistence/epic/role-claims";

const USER_A = "user-a";
const USER_B = "user-b";

const AGENT_A_LIVE = "agent-a-live";
const AGENT_A_GONE = "agent-a-gone";
const AGENT_B_LIVE = "agent-b-live";
const AGENT_B_GONE = "agent-b-gone";

function claim(overrides: {
  readonly claimId: string;
  readonly agentId: string;
  readonly userId: string;
  readonly claimedAt: number;
}): RoleClaim {
  return {
    claimId: overrides.claimId,
    agentId: overrides.agentId,
    userId: overrides.userId,
    role: "Planner",
    scope: "auth migration",
    claimedAt: overrides.claimedAt,
  };
}

// One epic, two collaborators. Each holds one claim by a LIVE agent and one
// orphaned by an agent that is gone.
const A_LIVE = claim({
  claimId: "11111111-1111-4111-8111-111111111111",
  agentId: AGENT_A_LIVE,
  userId: USER_A,
  claimedAt: 200,
});
const A_STALE = claim({
  claimId: "22222222-2222-4222-8222-222222222222",
  agentId: AGENT_A_GONE,
  userId: USER_A,
  claimedAt: 100,
});
const B_LIVE = claim({
  claimId: "33333333-3333-4333-8333-333333333333",
  agentId: AGENT_B_LIVE,
  userId: USER_B,
  claimedAt: 100,
});
const B_STALE = claim({
  claimId: "44444444-4444-4444-8444-444444444444",
  agentId: AGENT_B_GONE,
  userId: USER_B,
  claimedAt: 100,
});

const ALL_CLAIMS = [A_LIVE, A_STALE, B_LIVE, B_STALE];

/**
 * A live-agent set that records which agents it was asked about.
 *
 * Filter ORDER is invisible in the output - both orders drop the same claims -
 * so the only way to prove account-before-liveness is to observe that the
 * liveness lookup is never even consulted about another account's claim.
 * Subclasses `Set` rather than hand-rolling `ReadonlySet` so it stays a real
 * set (including the ES2024 set operations) with no type assertions.
 */
class RecordingLiveAgentIds extends Set<string> {
  readonly probed: string[] = [];

  override has(value: string): boolean {
    this.probed.push(value);
    return super.has(value);
  }
}

// B's agent is live in the epic - it is a real, running agent. It is excluded
// on ACCOUNT grounds, not because it is dead. That distinction is the point.
const LIVE_AGENT_IDS = new Set([AGENT_A_LIVE, AGENT_B_LIVE]);

describe("projectVisibleRoleClaims", () => {
  it("shows a caller only their own live claims in a shared epic", () => {
    const visible = projectVisibleRoleClaims(ALL_CLAIMS, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(visible).toEqual([A_LIVE]);
  });

  it("excludes another account's LIVE claim - the leak that overlap results and prompts would otherwise carry", () => {
    const visible = projectVisibleRoleClaims(ALL_CLAIMS, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(visible).not.toContain(B_LIVE);
    expect(visible.map((entry) => entry.userId)).not.toContain(USER_B);
  });

  it("excludes another account's STALE claim too", () => {
    const visible = projectVisibleRoleClaims(ALL_CLAIMS, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(visible).not.toContain(B_STALE);
  });

  it("excludes the caller's OWN claim once its agent is gone", () => {
    const visible = projectVisibleRoleClaims(ALL_CLAIMS, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(visible).not.toContain(A_STALE);
  });

  it("filters by account BEFORE liveness - proven by observing that liveness is never even asked about a foreign claim", () => {
    // Output alone cannot distinguish the two filter orders: both drop B's
    // claims, so an account-second implementation would pass an
    // output-only assertion. The ORDER is only observable through the
    // liveness lookup, so make that lookup record what it was asked.
    //
    // This matters beyond tidiness. Account-first means a foreign claim is
    // discarded before any other stage can touch it; account-second would
    // mean every future stage we add between the two filters gets to see
    // other accounts' claims, one refactor away from leaking them.
    const observed = new RecordingLiveAgentIds([
      AGENT_A_LIVE,
      AGENT_A_GONE,
      AGENT_B_LIVE,
      AGENT_B_GONE,
    ]);

    const visible = projectVisibleRoleClaims(ALL_CLAIMS, {
      userId: USER_A,
      liveAgentIds: observed,
    });
    const probedAgentIds = observed.probed;

    // Every agent is live here, so liveness excludes nothing. If the account
    // filter ran second, B's claims would have been probed for liveness -
    // and would have survived into the output.
    expect(probedAgentIds).not.toContain(AGENT_B_LIVE);
    expect(probedAgentIds).not.toContain(AGENT_B_GONE);
    expect(probedAgentIds).toEqual([AGENT_A_LIVE, AGENT_A_GONE]);

    expect(visible.every((entry) => entry.userId === USER_A)).toBe(true);
    expect(visible).toHaveLength(2);
  });

  it("orders claimId ties by CODE UNIT, not locale - mixed-case UUIDs must not reorder by host locale", () => {
    // UUIDs may carry mixed-case hex. `localeCompare` collates case by locale
    // (en-US puts "B" before "a"; code-unit order does not), which would make
    // two hosts render the same registry in different orders. Uppercase hex
    // sorts before lowercase by code unit, and that must hold everywhere.
    const mixedCase = [
      claim({
        claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentId: AGENT_A_LIVE,
        userId: USER_A,
        claimedAt: 42,
      }),
      claim({
        claimId: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
        agentId: AGENT_A_LIVE,
        userId: USER_A,
        claimedAt: 42,
      }),
    ];

    const visible = projectVisibleRoleClaims(mixedCase, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(visible.map((entry) => entry.claimId)).toEqual([
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
  });

  it("orders deterministically: claimedAt ascending, then claimId", () => {
    const sameInstant = [
      claim({
        claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentId: AGENT_A_LIVE,
        userId: USER_A,
        claimedAt: 500,
      }),
      claim({
        claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentId: AGENT_A_LIVE,
        userId: USER_A,
        claimedAt: 500,
      }),
      claim({
        claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        agentId: AGENT_A_LIVE,
        userId: USER_A,
        claimedAt: 1,
      }),
    ];

    const visible = projectVisibleRoleClaims(sameInstant, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(visible.map((entry) => entry.claimId)).toEqual([
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [...ALL_CLAIMS];
    projectVisibleRoleClaims(input, {
      userId: USER_A,
      liveAgentIds: LIVE_AGENT_IDS,
    });

    expect(input).toEqual(ALL_CLAIMS);
  });
});
