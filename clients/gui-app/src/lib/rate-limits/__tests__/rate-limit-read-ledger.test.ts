/**
 * The ledger's own bounds on the episode half: what keeps the map from growing
 * for the life of a window, given that nothing on screen may end an entry and
 * the renderer cannot enumerate the accounts of a host it is not pointed at.
 */
import { describe, expect, it } from "vitest";
import {
  pruneScheduledTransientReads,
  rateLimitAccountLedgerKey,
  recordScheduledTransientRead,
  scheduledTransientReadOwed,
} from "@/lib/rate-limits/rate-limit-read-ledger";

/** Above the cap, so a row can watch the eviction happen. */
const OVER_CAP = 300;

function key(hostId: string, profileId: string): string {
  return rateLimitAccountLedgerKey(hostId, "codex", profileId);
}

describe("the spent-episode map", () => {
  it("keeps the newest spends and evicts the oldest when it is full", () => {
    const host = "host-cap";
    const first = key(host, "account-0");
    recordScheduledTransientRead(first, 1);
    for (let index = 1; index < OVER_CAP; index += 1) {
      recordScheduledTransientRead(key(host, `account-${index}`), 1);
    }

    // The oldest entry is gone, which is the bound: a window that keeps
    // meeting accounts it has not seen cannot grow this map without limit.
    // The cost of an eviction is one extra unforced read for that account, and
    // the host's own floor bounds that.
    expect(scheduledTransientReadOwed(first, 1)).toBe(true);
    expect(
      scheduledTransientReadOwed(key(host, `account-${OVER_CAP - 1}`), 1),
    ).toBe(false);
  });

  it("keeps an account it spends again from being the oldest", () => {
    const host = "host-reinsert";
    const kept = key(host, "kept");
    recordScheduledTransientRead(kept, 1);
    for (let index = 0; index < 200; index += 1) {
      recordScheduledTransientRead(key(host, `other-${index}`), 1);
    }
    // The run of failures goes on, and its next episode spends a read too.
    recordScheduledTransientRead(kept, 2);
    for (let index = 200; index < OVER_CAP; index += 1) {
      recordScheduledTransientRead(key(host, `other-${index}`), 1);
    }

    expect(scheduledTransientReadOwed(kept, 2)).toBe(false);
  });

  it("drops the accounts a host no longer has, and nothing of any other host", () => {
    const here = "host-prune";
    const elsewhere = "host-elsewhere";
    recordScheduledTransientRead(key(here, "kept"), 1);
    recordScheduledTransientRead(key(here, "removed"), 1);
    recordScheduledTransientRead(key(elsewhere, "kept"), 1);

    pruneScheduledTransientReads(here, new Set([key(here, "kept")]));

    expect(scheduledTransientReadOwed(key(here, "kept"), 1)).toBe(false);
    expect(scheduledTransientReadOwed(key(here, "removed"), 1)).toBe(true);
    // A read goes to one host, and this one says nothing about the accounts of
    // any other: the strip can only ever hand over the inventory of the host
    // it is pointed at.
    expect(scheduledTransientReadOwed(key(elsewhere, "kept"), 1)).toBe(false);
  });
});
