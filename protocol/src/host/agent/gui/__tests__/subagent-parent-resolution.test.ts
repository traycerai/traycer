import { describe, expect, it } from "vitest";
import { accumulateEvent } from "../agent-runtime-accumulator";
import {
  parentBlockIdForEvent,
  type ParentResolution,
} from "../subagent-parent-resolution";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";

describe("parentBlockIdForEvent", () => {
  it.each<{
    readonly parent: ParentResolution;
    readonly projected: { readonly parentBlockId?: string | null };
  }>([
    { parent: { kind: "unresolved" }, projected: {} },
    { parent: { kind: "root" }, projected: { parentBlockId: null } },
    {
      parent: { kind: "subagent", runId: "codex-subagent-v2:turn-1:item-7" },
      projected: { parentBlockId: "codex-subagent-v2:turn-1:item-7" },
    },
  ])("projects $parent.kind", ({ parent, projected }) => {
    const out = parentBlockIdForEvent(parent);
    expect(out).toEqual(projected);
    // `unresolved` must OMIT the key (not set it to undefined) so a spread onto
    // an event carries no `parentBlockId` at all.
    expect("parentBlockId" in out).toBe(parent.kind !== "unresolved");
  });

  it("round-trips through the accumulator: unresolved preserves, root un-nests, subagent nests", () => {
    const started = (
      parent: ParentResolution,
      timestamp: number,
    ): ContentBlock[] =>
      accumulateEvent(blocks, {
        type: "subagent.started",
        blockId: "child",
        timestamp,
        name: "worker",
        ...parentBlockIdForEvent(parent),
      });

    let blocks: ContentBlock[] = [];
    blocks = started({ kind: "subagent", runId: "owner" }, 1);
    expect(blocks[0]).toMatchObject({ parentBlockId: "owner" });

    blocks = started({ kind: "unresolved" }, 2);
    expect(blocks[0]).toMatchObject({ parentBlockId: "owner" });

    blocks = started({ kind: "root" }, 3);
    expect(blocks[0]).toMatchObject({ parentBlockId: null });
  });
});
