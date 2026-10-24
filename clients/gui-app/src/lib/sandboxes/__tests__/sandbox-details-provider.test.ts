import { describe, expect, it } from "vitest";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { sandboxDetailsEntry } from "@/lib/sandboxes/sandbox-details-provider";

const NOW = 1_791_100_000_000;

describe("sandboxDetailsEntry", () => {
  it("exports the sandbox id as the support reference", () => {
    const summary = sandboxSummaryFixture({ id: "sbx_support_42" });
    const exported = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    }).export();
    expect(exported.sandboxId).toBe("sbx_support_42");
    expect(exported.status["Support reference"]).toBe("sbx_support_42");
  });

  it("lists Kept with no time, since the summary carries none for it", () => {
    const summary = sandboxSummaryFixture({
      keptBy: { userId: "u-priya", displayName: "Priya" },
      lastTransitionAt: NOW - 60_000,
    });
    const entry = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });
    const kept = entry.history.find((event) => event.label === "Kept");
    expect(kept?.at).toBeNull();
    expect(entry.history.at(-1)?.label).toBe("Kept");
    expect(
      entry.export().history.find((event) => event.event === "Kept")?.at,
    ).toBeNull();
  });

  it("carries no path, route or guest-authored text in the export", () => {
    const summary = sandboxSummaryFixture({
      state: "awake",
      guestConfigured: false,
      guestConfigFailureReason:
        "could not write /home/dev/.ssh/id_rsa: token=sk-secret-value",
      routes: [{ route: "host-route-secret", state: "unavailable", code: "x" }],
      failureCode: "boom",
    });
    const json = JSON.stringify(
      sandboxDetailsEntry({
        summary,
        cost: null,
        wakeString: null,
        viewerUserId: null,
        personal: true,
        now: NOW,
      }).export(),
    );
    expect(json).not.toContain("/home/dev");
    expect(json).not.toContain("sk-secret-value");
    expect(json).not.toContain("host-route-secret");
    expect(json).not.toMatch(/(^|[\s"])\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]/);
  });

  it("names no creator for a row that names none outside Personal", () => {
    const summary = sandboxSummaryFixture({ createdBy: null, burst: false });
    const entry = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: "u-me",
      personal: false,
      now: NOW,
    });
    expect(entry.export().status["Started by"]).toBeUndefined();
    expect(
      entry.history.find((event) => event.label === "Created")?.value,
    ).toBe("");
    const mine = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: "u-me",
      personal: true,
      now: NOW,
    });
    expect(mine.export().status["Started by"]).toBe("you");
  });

  it("gives an agent's sandbox no Resting row beside its self-destroying Idle row", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        burst: true,
        destroyAfterRestingMinutes: null,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: false,
      now: NOW,
    });
    expect(entry.export().status.Idle).toMatch(/destroys itself/);
    expect(entry.export().status.Resting).toBeUndefined();
  });
});
