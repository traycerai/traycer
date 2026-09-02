import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { describe, expect, it } from "vitest";
import {
  agentAppearance,
  hashAgentId,
  HARNESS_ACCENT,
  OFFICE_CHAT_ACCENT,
} from "@/lib/comm-graph/office/office-appearance";

const IDS = Array.from({ length: 100 }, (_, index) => `agent-${index}`);

describe("hashAgentId", () => {
  it("is stable and stays inside uint32", () => {
    expect(hashAgentId("agent-1")).toBe(hashAgentId("agent-1"));
    for (const id of IDS) {
      const hash = hashAgentId(id);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("separates ids that differ by one character", () => {
    expect(hashAgentId("agent-1")).not.toBe(hashAgentId("agent-2"));
  });
});

describe("agentAppearance", () => {
  it("is a pure function of the agent id, kind and harness", () => {
    // The office is redrawn from scratch on every mount and in every window;
    // an appearance that drifted would make the same agent a different person.
    expect(agentAppearance("agent-7", "terminal-agent", "claude")).toEqual(
      agentAppearance("agent-7", "terminal-agent", "claude"),
    );
  });

  it("carries the harness brand color as its accent", () => {
    expect(agentAppearance("a", "terminal-agent", "codex").accent).toBe(
      HARNESS_ACCENT.codex,
    );
    expect(agentAppearance("a", "terminal-agent", "opencode").accent).toBe(
      HARNESS_ACCENT.opencode,
    );
  });

  it("falls back to the app accent for a chat, which has no harness", () => {
    expect(agentAppearance("a", "chat", null).accent).toBe(OFFICE_CHAT_ACCENT);
  });

  it("gives every harness the app can run a parsable accent", () => {
    // A missing entry resolves to `undefined` and paints that agent's
    // envelopes with nothing at all, which reads as a rendering bug rather
    // than as a harness nobody assigned a color to.
    for (const harnessId of guiHarnessIdSchema.options) {
      const accent = agentAppearance("a", "terminal-agent", harnessId).accent;
      expect(accent, harnessId).toBe(HARNESS_ACCENT[harnessId]);
      expect(accent, harnessId).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps the accents distinct enough to tell two harnesses apart", () => {
    // Two harnesses sharing a tint makes the envelope color say nothing. Only
    // `traycer` may collide, with the chat accent: the same product.
    const accents = guiHarnessIdSchema.options
      .filter((harnessId) => harnessId !== "traycer")
      .map((harnessId) => HARNESS_ACCENT[harnessId]);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it("distributes across every curated list", () => {
    const looks = IDS.map((id) => agentAppearance(id, "terminal-agent", null));
    expect(new Set(looks.map((look) => look.shirt)).size).toBeGreaterThan(4);
    expect(new Set(looks.map((look) => look.skin)).size).toBeGreaterThan(3);
    expect(new Set(looks.map((look) => look.hair)).size).toBeGreaterThan(4);
    expect(new Set(looks.map((look) => look.hairStyle)).size).toBe(4);
    expect(new Set(looks.map((look) => look.pants)).size).toBe(4);
  });

  it("does not correlate two attributes into the same draw", () => {
    // One hash feeding every list unmixed would make hair style a function of
    // shirt color, and a floor of agents would read as a uniform.
    const pairs = new Set(
      IDS.map((id) => {
        const look = agentAppearance(id, "chat", null);
        return `${look.shirt}/${look.hairStyle}`;
      }),
    );
    expect(pairs.size).toBeGreaterThan(
      new Set(IDS.map((id) => agentAppearance(id, "chat", null).shirt)).size,
    );
  });

  it("emits colors the rasterizer can parse", () => {
    const look = agentAppearance("agent-3", "terminal-agent", "cursor");
    for (const value of [
      look.skin,
      look.hair,
      look.shirt,
      look.pants,
      look.accent,
    ]) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
