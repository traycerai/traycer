import { describe, expect, it } from "vitest";
import { EpicTitleEchoes } from "../epic-title-echoes";

describe("compacted title correlation", () => {
  it("keeps compatible evidence from an earlier possible dispatch when its retry is unsent", () => {
    const echoes = new EpicTitleEchoes(() => {});
    const baseline = "Original";
    echoes.observes({ title: baseline, updatedAt: 0 }, baseline);
    echoes.finish(echoes.begin("a", "Alpha", 1), true);
    echoes.finish(echoes.begin("b", "Beta", 2), true);
    expect(echoes.observes({ title: "Beta", updatedAt: 2 }, baseline)).toBe(
      true,
    );

    echoes.finish(echoes.begin("c", "Alpha", 3), true);
    const retry = echoes.begin("c", "Alpha", 3);
    const obsolete = { title: "Alpha", updatedAt: 1 };
    expect(echoes.observes(obsolete, baseline)).toBe(true);
    echoes.finish(retry, false);

    expect(echoes.observes(obsolete, baseline)).toBe(true);
    expect(echoes.awaitsEcho("c")).toBe(true);
    expect(echoes.echoes("c")).toBe(false);
  });

  it("does not assign a timestamp-only patch to a surviving earlier send", () => {
    const echoes = new EpicTitleEchoes(() => {});
    const baseline = "Original";
    echoes.observes({ title: baseline, updatedAt: 0 }, baseline);
    echoes.finish(echoes.begin("a", "Alpha", 1), true);

    const later = echoes.begin("c", "Alpha", 2);
    expect(echoes.observes({ title: "Alpha", updatedAt: 2 }, baseline)).toBe(
      true,
    );
    const timestampOnly = { title: "Alpha", updatedAt: 1 };
    expect(echoes.observes(timestampOnly, baseline)).toBe(true);
    echoes.finish(later, false);

    expect(echoes.observes(timestampOnly, baseline)).toBe(true);
    expect(echoes.echoes("a")).toBe(false);
    expect(echoes.awaitsEcho("a")).toBe(true);
  });

  it("rejects conflicting movement and ignores a retired send's reply", () => {
    const echoes = new EpicTitleEchoes(() => {});
    const baseline = "Original";
    echoes.observes({ title: baseline, updatedAt: 0 }, baseline);
    const sending = echoes.begin("a", "Alpha", 1);
    expect(echoes.observes({ title: "Alpha", updatedAt: 1 }, baseline)).toBe(
      true,
    );
    expect(
      echoes.observes({ title: "Other writer", updatedAt: 2 }, baseline),
    ).toBe(false);

    echoes.clear();
    echoes.finish(sending, true);
    expect(echoes.awaitsEcho("a")).toBe(false);
    expect(echoes.observes({ title: "Alpha", updatedAt: 1 }, baseline)).toBe(
      false,
    );
  });

  it("keeps uncertain echoes unattributed when the correlation budget is exhausted", () => {
    const echoes = new EpicTitleEchoes(() => {});
    const baseline = "Original";
    echoes.observes({ title: baseline, updatedAt: 0 }, baseline);

    // Produce enough observed sends in one live chain to exhaust the retained
    // stamps. The first Alpha stamp is no longer available for comparison.
    for (let index = 0; index < 65; index += 1) {
      const title = index === 0 ? "Alpha" : `Title ${index}`;
      const send = echoes.begin(`write-${index}`, title, index + 1);
      expect(echoes.observes({ title, updatedAt: index + 1 }, baseline)).toBe(
        true,
      );
      echoes.finish(send, true);
    }

    const latest = echoes.begin("new-alpha", "Alpha", 1);
    echoes.finish(latest, true);
    expect(echoes.observes({ title: "Alpha", updatedAt: 1 }, baseline)).toBe(
      true,
    );
    expect(echoes.echoes(latest.requestId)).toBe(false);
    expect(
      echoes.observes({ title: "Other writer", updatedAt: 66 }, baseline),
    ).toBe(false);

    // A fresh chain can once again settle a sole candidate whose timestamp
    // was moved by unrelated metadata.
    echoes.clear();
    echoes.observes({ title: baseline, updatedAt: 0 }, baseline);
    const fresh = echoes.begin("fresh-alpha", "Alpha", 67);
    echoes.finish(fresh, true);
    expect(echoes.observes({ title: "Alpha", updatedAt: 68 }, baseline)).toBe(
      true,
    );
    expect(echoes.echoes(fresh.requestId)).toBe(true);
  });
});
