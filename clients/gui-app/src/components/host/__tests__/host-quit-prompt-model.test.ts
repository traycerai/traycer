import { describe, expect, it } from "vitest";
import type { HostQuitDecisionRequest } from "@traycer-clients/shared/platform/runner-host";
import type { HostQuitVerdict } from "@/components/host/use-local-host-quit-status";
import {
  automaticHostQuitDecision,
  describeHostQuitPrompt,
  hostQuitPromptVisible,
} from "@/components/host/host-quit-prompt-model";
import {
  HOST_QUIT_DESCRIPTION_BUSY,
  HOST_QUIT_DESCRIPTION_BUSY_RETRY,
  HOST_QUIT_DESCRIPTION_CHECKING,
  HOST_QUIT_DESCRIPTION_IDLE,
  HOST_QUIT_STOP_LABEL,
  HOST_QUIT_STOP_UNKNOWN_LABEL,
  HOST_QUIT_TITLE_BUSY,
  HOST_QUIT_TITLE_CHECKING,
  HOST_QUIT_TITLE_IDLE,
  HOST_QUIT_TITLE_UNKNOWN,
  hostQuitUnknownDescription,
} from "@/lib/host/host-lifecycle-copy";

const LOCAL_HOST_ID = "host-local-1";

function request(
  mode: "ask" | "stop-if-idle",
  round: "initial" | "busy" | "busy-retry",
): HostQuitDecisionRequest {
  return { requestId: "req-1", mode, round };
}

const CHECKING_VERDICT: HostQuitVerdict = { kind: "checking" };
const NO_LOCAL_HOST_VERDICT: HostQuitVerdict = { kind: "no-local-host" };
const UNKNOWN_VERDICT: HostQuitVerdict = {
  kind: "unknown",
  reason: "unreachable",
};
const BUSY_VERDICT: HostQuitVerdict = {
  kind: "busy",
  busySessionCount: 2,
  breakdown: null,
  statusMinor: 6,
};
const IDLE_VERDICT: HostQuitVerdict = {
  kind: "idle",
  busySessionCount: 0,
  breakdown: null,
  statusMinor: 6,
};

describe("describeHostQuitPrompt - initial round", () => {
  it("checking: shows the checking title/description, disabled Stop, no counts line", () => {
    const model = describeHostQuitPrompt(
      request("ask", "initial"),
      CHECKING_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.title).toBe(HOST_QUIT_TITLE_CHECKING);
    expect(model.description).toBe(HOST_QUIT_DESCRIPTION_CHECKING);
    expect(model.stopLabel).toBe(HOST_QUIT_STOP_LABEL);
    expect(model.stopDisabled).toBe(true);
    expect(model.countsLine).toBeNull();
  });

  it("busy: title/description/stop label, Stop sends force:true, enabled, counts line present", () => {
    const model = describeHostQuitPrompt(
      request("ask", "initial"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.title).toBe(HOST_QUIT_TITLE_BUSY);
    expect(model.description).toBe(HOST_QUIT_DESCRIPTION_BUSY);
    expect(model.stopLabel).toBe(HOST_QUIT_STOP_LABEL);
    expect(model.stopDisabled).toBe(false);
    expect(model.stopForce).toBe(true);
    expect(model.countsLine).not.toBeNull();
    expect(model.analyticsVerdict).toBe("busy");
  });

  it("idle: title/description/stop label, Stop sends force:false, enabled, counts line present", () => {
    const model = describeHostQuitPrompt(
      request("ask", "initial"),
      IDLE_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.title).toBe(HOST_QUIT_TITLE_IDLE);
    expect(model.description).toBe(HOST_QUIT_DESCRIPTION_IDLE);
    expect(model.stopLabel).toBe(HOST_QUIT_STOP_LABEL);
    expect(model.stopDisabled).toBe(false);
    expect(model.stopForce).toBe(false);
    expect(model.countsLine).toBe(
      "Nothing is running on this host right now. Shells and scheduled wakes: not reported by this host.",
    );
    expect(model.analyticsVerdict).toBe("idle");
  });

  it("unknown: title, description names the reason, stop-anyway label with force:true, no counts line", () => {
    const model = describeHostQuitPrompt(
      request("ask", "initial"),
      UNKNOWN_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.title).toBe(HOST_QUIT_TITLE_UNKNOWN);
    expect(model.description).toBe(hostQuitUnknownDescription("unreachable"));
    expect(model.stopLabel).toBe(HOST_QUIT_STOP_UNKNOWN_LABEL);
    expect(model.stopDisabled).toBe(false);
    expect(model.stopForce).toBe(true);
    expect(model.countsLine).toBeNull();
    expect(model.analyticsVerdict).toBe("unknown");
  });

  it("no-local-host: same checking display shape as 'checking'", () => {
    const model = describeHostQuitPrompt(
      request("ask", "initial"),
      NO_LOCAL_HOST_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.title).toBe(HOST_QUIT_TITLE_CHECKING);
    expect(model.description).toBe(HOST_QUIT_DESCRIPTION_CHECKING);
    expect(model.stopDisabled).toBe(true);
    expect(model.countsLine).toBeNull();
  });
});

describe("describeHostQuitPrompt - busy round (Stop-if-idle's own first ask)", () => {
  const VERDICTS: ReadonlyArray<readonly [string, HostQuitVerdict]> = [
    ["busy", BUSY_VERDICT],
    ["idle", IDLE_VERDICT],
  ];
  for (const [label, verdict] of VERDICTS) {
    it(`${label} verdict: busy title, the NON-retry busy description, stateKind busy-round, force, visible, no automatic answer`, () => {
      const req = request("stop-if-idle", "busy");
      const model = describeHostQuitPrompt(req, verdict, LOCAL_HOST_ID);

      expect(model.title).toBe(HOST_QUIT_TITLE_BUSY);
      expect(model.description).toBe(HOST_QUIT_DESCRIPTION_BUSY);
      expect(model.description).not.toBe(HOST_QUIT_DESCRIPTION_BUSY_RETRY);
      expect(model.stateKind).toBe("busy-round");
      expect(model.stopLabel).toBe(HOST_QUIT_STOP_LABEL);
      expect(model.stopForce).toBe(true);
      expect(model.analyticsVerdict).toBe("busy");

      // Never auto-answered, even for the idle verdict that WOULD auto-answer
      // on an initial stop-if-idle round: the busy round is always the
      // person's, because the host has just refused the silent idle-only
      // stop.
      expect(automaticHostQuitDecision(req, verdict)).toBeNull();
      expect(hostQuitPromptVisible(req, verdict)).toBe(true);
    });
  }

  it("checking verdict: stateKind busy-round-checking, Stop disabled", () => {
    const req = request("stop-if-idle", "busy");
    const model = describeHostQuitPrompt(req, CHECKING_VERDICT, LOCAL_HOST_ID);
    expect(model.stateKind).toBe("busy-round-checking");
    expect(model.stopDisabled).toBe(true);
    expect(model.title).toBe(HOST_QUIT_TITLE_BUSY);
    expect(model.description).toBe(HOST_QUIT_DESCRIPTION_BUSY);
    expect(automaticHostQuitDecision(req, CHECKING_VERDICT)).toBeNull();
  });

  it("unknown verdict: detail is the unknown description, never CLI text", () => {
    const model = describeHostQuitPrompt(
      request("stop-if-idle", "busy"),
      UNKNOWN_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(model.detail).toBe(hostQuitUnknownDescription("unreachable"));
    expect(model.detail).not.toContain("--force");
    expect(model.detail).not.toContain("Re-run");
  });

  it("a busy or idle verdict on the busy round has no detail (unknown-only)", () => {
    for (const verdict of [BUSY_VERDICT, IDLE_VERDICT, CHECKING_VERDICT]) {
      const model = describeHostQuitPrompt(
        request("stop-if-idle", "busy"),
        verdict,
        LOCAL_HOST_ID,
      );
      expect(model.detail).toBeNull();
    }
  });
});

describe("describeHostQuitPrompt - busy-retry round", () => {
  it("is always the busy title/RETRY description, whatever the fresh verdict says", () => {
    for (const verdict of [BUSY_VERDICT, IDLE_VERDICT, UNKNOWN_VERDICT]) {
      const model = describeHostQuitPrompt(
        request("ask", "busy-retry"),
        verdict,
        LOCAL_HOST_ID,
      );

      expect(model.title).toBe(HOST_QUIT_TITLE_BUSY);
      expect(model.description).toBe(HOST_QUIT_DESCRIPTION_BUSY_RETRY);
      expect(model.stateKind).toMatch(/^busy-retry/);
      expect(model.stopLabel).toBe(HOST_QUIT_STOP_LABEL);
      expect(model.stopForce).toBe(true);
      expect(model.analyticsVerdict).toBe("busy");
    }
  });

  it("disables Stop only while the retry's fresh read is still checking", () => {
    const checkingRetry = describeHostQuitPrompt(
      request("ask", "busy-retry"),
      CHECKING_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(checkingRetry.stopDisabled).toBe(true);
    expect(checkingRetry.stateKind).toBe("busy-retry-checking");

    const busyRetry = describeHostQuitPrompt(
      request("ask", "busy-retry"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(busyRetry.stopDisabled).toBe(false);
    expect(busyRetry.stateKind).toBe("busy-retry");
  });

  it("detail is null for a busy or idle verdict, and the unknown description for an unknown verdict - never CLI text", () => {
    const busy = describeHostQuitPrompt(
      request("ask", "busy-retry"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(busy.detail).toBeNull();

    const idle = describeHostQuitPrompt(
      request("ask", "busy-retry"),
      IDLE_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(idle.detail).toBeNull();

    const unknown = describeHostQuitPrompt(
      request("ask", "busy-retry"),
      UNKNOWN_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(unknown.detail).toBe(hostQuitUnknownDescription("unreachable"));
    expect(unknown.detail).not.toContain("--force");
    expect(unknown.detail).not.toContain("Re-run");
  });

  it("reads the counts line when the fresh verdict carries facts", () => {
    const model = describeHostQuitPrompt(
      request("stop-if-idle", "busy-retry"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.countsLine).not.toBeNull();
  });
});

describe("automaticHostQuitDecision", () => {
  it("no-local-host + ask: auto-answers keep, remember:false", () => {
    expect(
      automaticHostQuitDecision(
        request("ask", "initial"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toEqual({ kind: "keep", remember: false });
  });

  it("no-local-host + stop-if-idle: auto-answers stop, force:false, remember:false", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "initial"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toEqual({ kind: "stop", force: false, remember: false });
  });

  it("stop-if-idle + initial + idle: auto-answers stop, force:false, remember:false", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "initial"),
        IDLE_VERDICT,
      ),
    ).toEqual({ kind: "stop", force: false, remember: false });
  });

  it("ask + initial + idle: never auto-answers (shows the prompt)", () => {
    expect(
      automaticHostQuitDecision(request("ask", "initial"), IDLE_VERDICT),
    ).toBeNull();
  });

  it("stop-if-idle + initial + busy: never auto-answers", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "initial"),
        BUSY_VERDICT,
      ),
    ).toBeNull();
  });

  it("busy round: never auto-answers, even for no-local-host or idle", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "busy"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBeNull();
    expect(
      automaticHostQuitDecision(request("stop-if-idle", "busy"), IDLE_VERDICT),
    ).toBeNull();
  });

  it("busy-retry round: never auto-answers, even for no-local-host or idle", () => {
    expect(
      automaticHostQuitDecision(
        request("ask", "busy-retry"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBeNull();
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "busy-retry"),
        IDLE_VERDICT,
      ),
    ).toBeNull();
  });
});

describe("hostQuitPromptVisible", () => {
  it("busy round is always visible, regardless of mode or verdict", () => {
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "busy"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(request("stop-if-idle", "busy"), IDLE_VERDICT),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(request("stop-if-idle", "busy"), CHECKING_VERDICT),
    ).toBe(true);
  });

  it("busy-retry round is always visible, regardless of mode or verdict", () => {
    expect(
      hostQuitPromptVisible(
        request("ask", "busy-retry"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "busy-retry"),
        IDLE_VERDICT,
      ),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(request("ask", "busy-retry"), CHECKING_VERDICT),
    ).toBe(true);
  });

  it("no-local-host is always hidden outside busy/busy-retry", () => {
    expect(
      hostQuitPromptVisible(request("ask", "initial"), NO_LOCAL_HOST_VERDICT),
    ).toBe(false);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBe(false);
  });

  it("ask mode: always visible outside no-local-host, including checking", () => {
    expect(
      hostQuitPromptVisible(request("ask", "initial"), CHECKING_VERDICT),
    ).toBe(true);
    expect(hostQuitPromptVisible(request("ask", "initial"), BUSY_VERDICT)).toBe(
      true,
    );
    expect(hostQuitPromptVisible(request("ask", "initial"), IDLE_VERDICT)).toBe(
      true,
    );
    expect(
      hostQuitPromptVisible(request("ask", "initial"), UNKNOWN_VERDICT),
    ).toBe(true);
  });

  it("stop-if-idle mode: hidden while checking or idle, visible for busy or unknown", () => {
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial"),
        CHECKING_VERDICT,
      ),
    ).toBe(false);
    expect(
      hostQuitPromptVisible(request("stop-if-idle", "initial"), IDLE_VERDICT),
    ).toBe(false);
    expect(
      hostQuitPromptVisible(request("stop-if-idle", "initial"), BUSY_VERDICT),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial"),
        UNKNOWN_VERDICT,
      ),
    ).toBe(true);
  });
});

describe("common invariants", () => {
  it("uses the same Keep label content path whenever the prompt is shown and not auto-answered/hidden/checking", () => {
    // Keep/Cancel labels live as constants consumed by the dialog view, not
    // by the model itself - this asserts the model states that support that:
    // whenever the model is visible and not a hard-disabled checking state,
    // the modal has something concrete to show besides Stop.
    const busy = describeHostQuitPrompt(
      request("ask", "initial"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(hostQuitPromptVisible(request("ask", "initial"), BUSY_VERDICT)).toBe(
      true,
    );
    expect(busy.stopDisabled).toBe(false);

    const idle = describeHostQuitPrompt(
      request("ask", "initial"),
      IDLE_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(hostQuitPromptVisible(request("ask", "initial"), IDLE_VERDICT)).toBe(
      true,
    );
    expect(idle.stopDisabled).toBe(false);

    const unknown = describeHostQuitPrompt(
      request("ask", "initial"),
      UNKNOWN_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(
      hostQuitPromptVisible(request("ask", "initial"), UNKNOWN_VERDICT),
    ).toBe(true);
    expect(unknown.stopDisabled).toBe(false);

    const retry = describeHostQuitPrompt(
      request("ask", "busy-retry"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(
      hostQuitPromptVisible(request("ask", "busy-retry"), BUSY_VERDICT),
    ).toBe(true);
    expect(retry.stopDisabled).toBe(false);
  });

  it("no rendered detail across any round/verdict combination ever contains CLI text", () => {
    const rounds: ReadonlyArray<HostQuitDecisionRequest["round"]> = [
      "initial",
      "busy",
      "busy-retry",
    ];
    const verdicts: readonly HostQuitVerdict[] = [
      CHECKING_VERDICT,
      NO_LOCAL_HOST_VERDICT,
      UNKNOWN_VERDICT,
      BUSY_VERDICT,
      IDLE_VERDICT,
    ];
    for (const round of rounds) {
      for (const verdict of verdicts) {
        const model = describeHostQuitPrompt(
          request("ask", round),
          verdict,
          LOCAL_HOST_ID,
        );
        expect(model.detail ?? "").not.toContain("--force");
        expect(model.detail ?? "").not.toContain("Re-run");
      }
    }
  });
});
