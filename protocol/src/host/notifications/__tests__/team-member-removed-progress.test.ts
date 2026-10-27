import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV23,
} from "@traycer/protocol/host/notifications/contracts";

// A removed member's row counts a host "done" only
// when ALL THREE of its facts have arrived (the machine stopped, the old
// credential closed, the replacement delivered). `secret-rotated-and-team-
// kinds.test.ts` pins the count for one host with two facts pending; this file
// holds each fact alone, since a count that forgot one of the three would say a
// removal is finished while a credential is still open.

const FACTS = ["stopped", "credentialClosed", "replacementDelivered"] as const;
type Fact = (typeof FACTS)[number];

type FactState = "pending" | "done";

function removalPresentation(
  hosts: ReadonlyArray<Record<Fact, FactState>>,
  toRemovedMember: boolean | undefined,
) {
  const entry = hostNotificationEntrySchemaV23.parse({
    id: "entry-1",
    updatedAt: 1_700_000_000_000,
    readAt: null,
    sourceRef: "source-1",
    epicId: null,
    chatId: null,
    kind: "team.member.removed",
    severity: "info",
    outcome: "completed",
    payload: {
      kind: "team_member_removed",
      environmentId: "env-1",
      teamName: "Acme",
      memberName: "Sam",
      hosts: hosts.map((facts, index) => ({
        hostId: `host-${index}`,
        hostName: `Host ${index}`,
        ...facts,
      })),
      toRemovedMember,
    },
  });
  return formatHostNotificationPresentation(entry);
}

function removalBody(hosts: ReadonlyArray<Record<Fact, FactState>>): string {
  return removalPresentation(hosts, undefined).body;
}

const ALL_DONE: Record<Fact, FactState> = {
  stopped: "done",
  credentialClosed: "done",
  replacementDelivered: "done",
};

describe("a removal's per-host progress", () => {
  it.each(FACTS)(
    "does not count a host whose only pending fact is %s",
    (fact) => {
      expect(removalBody([{ ...ALL_DONE, [fact]: "pending" }])).toBe(
        "Sam • Acme • 0 of 1 hosts done",
      );
    },
  );

  it.each(FACTS)(
    "counts the finished host and not the one still waiting on %s",
    (fact) => {
      expect(removalBody([ALL_DONE, { ...ALL_DONE, [fact]: "pending" }])).toBe(
        "Sam • Acme • 1 of 2 hosts done",
      );
    },
  );

  it("counts a host once all three facts have arrived", () => {
    expect(removalBody([ALL_DONE, ALL_DONE])).toBe(
      "Sam is no longer in Acme.",
    );
  });
});

describe("the notice told to the person removed", () => {
  it("says they are no longer a member, not a host-progress line", () => {
    expect(removalPresentation([ALL_DONE], true)).toEqual({
      title: "No longer a member",
      body: "You are no longer a member of Acme.",
    });
  });

  it("names the removed member in the admins' completed row", () => {
    expect(removalPresentation([ALL_DONE], false).body).toBe(
      "Sam is no longer in Acme.",
    );
  });
});
