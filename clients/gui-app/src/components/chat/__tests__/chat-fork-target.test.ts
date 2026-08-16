import { describe, expect, it } from "vitest";
import {
  CHAT_FORK_NEEDS_UPDATE_WORD,
  chatForkHostRefusals,
  chatForkTargetSupport,
} from "../chat-fork-target";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

describe("chatForkTargetSupport", () => {
  it("treats 1.2 and a later same-major minor as supported", () => {
    expect(chatForkTargetSupport({ major: 1, minor: 2 })).toEqual({
      kind: "supported",
    });
    expect(chatForkTargetSupport({ major: 1, minor: 3 })).toEqual({
      kind: "supported",
    });
  });

  it("refuses a completed handshake that omitted the method as needs-update", () => {
    expect(chatForkTargetSupport(false)).toEqual({
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail: "This host can't create agents yet - update it to fork here.",
    });
  });

  it("refuses a same-major build below 1.2 as needs-update", () => {
    expect(chatForkTargetSupport({ major: 1, minor: 1 })).toEqual({
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail:
        "This host's build can't receive a fork from another machine. Update it and try again.",
    });
    expect(chatForkTargetSupport({ major: 1, minor: 0 })).toEqual({
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail:
        "This host's build can't receive a fork from another machine. Update it and try again.",
    });
  });

  it("refuses an unrecognized major as incompatible, not as needs-update", () => {
    expect(chatForkTargetSupport({ major: 2, minor: 0 })).toEqual({
      kind: "refused",
      word: "incompatible",
      detail:
        "This host speaks a different version of the agent-create contract, so this app can't fork onto it.",
    });
    expect(chatForkTargetSupport({ major: 0, minor: 9 })).toEqual({
      kind: "refused",
      word: "incompatible",
      detail:
        "This host speaks a different version of the agent-create contract, so this app can't fork onto it.",
    });
  });

  it("treats a missing handshake as unknown, not refused", () => {
    // `null` is "we have not spoken to this host yet". Rendering "needs update"
    // here would assert a build fact this client does not have.
    expect(chatForkTargetSupport(null)).toEqual({ kind: "unknown" });
  });
});

describe("chatForkHostRefusals", () => {
  const versionByHostId = new Map<string, NegotiatedMethodVersion>([
    ["source-host", { major: 1, minor: 0 }],
    ["old-host", { major: 1, minor: 1 }],
    ["absent-host", false],
    ["unknown-host", null],
    ["ready-host", { major: 1, minor: 2 }],
    ["ahead-host", { major: 2, minor: 0 }],
  ]);

  it("exempts the source host even when its build would otherwise be refused", () => {
    const refusals = chatForkHostRefusals({
      versionByHostId,
      sourceHostId: "source-host",
    });
    expect(refusals.has("source-host")).toBe(false);
    expect(refusals.get("old-host")).toBe(CHAT_FORK_NEEDS_UPDATE_WORD);
    expect(refusals.get("absent-host")).toBe(CHAT_FORK_NEEDS_UPDATE_WORD);
    expect(refusals.get("ahead-host")).toBe("incompatible");
    expect(refusals.has("unknown-host")).toBe(false);
    expect(refusals.has("ready-host")).toBe(false);
  });

  it("does not invent a source exemption when sourceHostId is null", () => {
    const refusals = chatForkHostRefusals({
      versionByHostId,
      sourceHostId: null,
    });
    expect(refusals.get("source-host")).toBe(CHAT_FORK_NEEDS_UPDATE_WORD);
  });
});
