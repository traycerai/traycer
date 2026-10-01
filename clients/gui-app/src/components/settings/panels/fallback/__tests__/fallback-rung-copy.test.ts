import { describe, expect, it } from "vitest";
import { FRESH_SESSION_HELPER } from "@/components/chat/fallback/fallback-copy";
import { FALLBACK_RUNG_COPY } from "@/components/settings/panels/fallback/fallback-rung-copy";

/**
 * `profile` and `tier` are both a wire `switch` and start a new agent
 * session. Settings used to say "Continues" (profile) and stay silent
 * (tier); chat already pushed `FRESH_SESSION_HELPER` at the moment of the
 * switch. The same sentence, not a paraphrase, so the two surfaces cannot
 * drift.
 *
 * Mirrors `chat-announcements-fallback.test.ts`: switch-text contains the
 * helper, retry/wait text does not.
 */
describe("FALLBACK_RUNG_COPY", () => {
  it("states the fresh-session consequence on the two switch steps, and not on wait or notify", () => {
    expect(FALLBACK_RUNG_COPY.profile.description).toContain(
      FRESH_SESSION_HELPER,
    );
    expect(FALLBACK_RUNG_COPY.tier.description).toContain(FRESH_SESSION_HELPER);
    expect(FALLBACK_RUNG_COPY.wait.description).not.toContain(
      FRESH_SESSION_HELPER,
    );
    expect(FALLBACK_RUNG_COPY.notify.description).not.toContain(
      FRESH_SESSION_HELPER,
    );
  });
});
