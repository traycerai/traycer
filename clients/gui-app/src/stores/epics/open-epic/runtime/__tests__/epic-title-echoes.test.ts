import { describe, expect, it } from "vitest";
import { EpicTitleEchoes } from "../epic-title-echoes";

describe("compacted title correlation", () => {
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
