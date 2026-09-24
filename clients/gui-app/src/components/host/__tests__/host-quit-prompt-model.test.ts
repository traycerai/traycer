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
  round: "initial" | "busy-retry",
  busyMessage: string | null,
): HostQuitDecisionRequest {
  return {
    requestId: "req-1",
    mode,
    round,
    busyMessage,
  };
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
      request("ask", "initial", null),
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
      request("ask", "initial", null),
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
      request("ask", "initial", null),
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
      request("ask", "initial", null),
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
      request("ask", "initial", null),
      NO_LOCAL_HOST_VERDICT,
      LOCAL_HOST_ID,
    );

    expect(model.title).toBe(HOST_QUIT_TITLE_CHECKING);
    expect(model.description).toBe(HOST_QUIT_DESCRIPTION_CHECKING);
    expect(model.stopDisabled).toBe(true);
    expect(model.countsLine).toBeNull();
  });
});

describe("describeHostQuitPrompt - busy-retry round", () => {
  it("is always the busy title/description, whatever the fresh verdict says", () => {
    for (const verdict of [BUSY_VERDICT, IDLE_VERDICT, UNKNOWN_VERDICT]) {
      const model = describeHostQuitPrompt(
        request("ask", "busy-retry", "Something is still running"),
        verdict,
        LOCAL_HOST_ID,
      );

      expect(model.title).toBe(HOST_QUIT_TITLE_BUSY);
      expect(model.description).toBe(HOST_QUIT_DESCRIPTION_BUSY_RETRY);
      expect(model.stopLabel).toBe(HOST_QUIT_STOP_LABEL);
      expect(model.stopForce).toBe(true);
      expect(model.analyticsVerdict).toBe("busy");
    }
  });

  it("disables Stop only while the retry's fresh read is still checking", () => {
    const checkingRetry = describeHostQuitPrompt(
      request("ask", "busy-retry", "Something is still running"),
      CHECKING_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(checkingRetry.stopDisabled).toBe(true);

    const busyRetry = describeHostQuitPrompt(
      request("ask", "busy-retry", "Something is still running"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(busyRetry.stopDisabled).toBe(false);
  });

  it("carries the busyMessage as detail, and joins the unknown-reason sentence onto it for an unknown verdict", () => {
    const busy = describeHostQuitPrompt(
      request("ask", "busy-retry", "Refused: something started"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(busy.detail).toBe("Refused: something started");

    const unknown = describeHostQuitPrompt(
      request("ask", "busy-retry", "Refused: something started"),
      UNKNOWN_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(unknown.detail).toBe(
      `Refused: something started ${hostQuitUnknownDescription("unreachable")}`,
    );
  });

  it("reads the counts line when the fresh verdict carries facts", () => {
    const model = describeHostQuitPrompt(
      request("stop-if-idle", "busy-retry", "Refused: busy again"),
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
        request("ask", "initial", null),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toEqual({ kind: "keep", remember: false });
  });

  it("no-local-host + stop-if-idle: auto-answers stop, force:false, remember:false", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "initial", null),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toEqual({ kind: "stop", force: false, remember: false });
  });

  it("stop-if-idle + initial + idle: auto-answers stop, force:false, remember:false", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "initial", null),
        IDLE_VERDICT,
      ),
    ).toEqual({ kind: "stop", force: false, remember: false });
  });

  it("ask + initial + idle: never auto-answers (shows the prompt)", () => {
    expect(
      automaticHostQuitDecision(request("ask", "initial", null), IDLE_VERDICT),
    ).toBeNull();
  });

  it("stop-if-idle + initial + busy: never auto-answers", () => {
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "initial", null),
        BUSY_VERDICT,
      ),
    ).toBeNull();
  });

  it("busy-retry round: never auto-answers, even for no-local-host or idle", () => {
    expect(
      automaticHostQuitDecision(
        request("ask", "busy-retry", "msg"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBeNull();
    expect(
      automaticHostQuitDecision(
        request("stop-if-idle", "busy-retry", "msg"),
        IDLE_VERDICT,
      ),
    ).toBeNull();
  });
});

describe("hostQuitPromptVisible", () => {
  it("busy-retry round is always visible, regardless of mode or verdict", () => {
    expect(
      hostQuitPromptVisible(
        request("ask", "busy-retry", "msg"),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "busy-retry", "msg"),
        IDLE_VERDICT,
      ),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(
        request("ask", "busy-retry", "msg"),
        CHECKING_VERDICT,
      ),
    ).toBe(true);
  });

  it("no-local-host is always hidden outside busy-retry", () => {
    expect(
      hostQuitPromptVisible(
        request("ask", "initial", null),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBe(false);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial", null),
        NO_LOCAL_HOST_VERDICT,
      ),
    ).toBe(false);
  });

  it("ask mode: always visible outside no-local-host, including checking", () => {
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), CHECKING_VERDICT),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), BUSY_VERDICT),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), IDLE_VERDICT),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), UNKNOWN_VERDICT),
    ).toBe(true);
  });

  it("stop-if-idle mode: hidden while checking or idle, visible for busy or unknown", () => {
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial", null),
        CHECKING_VERDICT,
      ),
    ).toBe(false);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial", null),
        IDLE_VERDICT,
      ),
    ).toBe(false);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial", null),
        BUSY_VERDICT,
      ),
    ).toBe(true);
    expect(
      hostQuitPromptVisible(
        request("stop-if-idle", "initial", null),
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
      request("ask", "initial", null),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), BUSY_VERDICT),
    ).toBe(true);
    expect(busy.stopDisabled).toBe(false);

    const idle = describeHostQuitPrompt(
      request("ask", "initial", null),
      IDLE_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), IDLE_VERDICT),
    ).toBe(true);
    expect(idle.stopDisabled).toBe(false);

    const unknown = describeHostQuitPrompt(
      request("ask", "initial", null),
      UNKNOWN_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(
      hostQuitPromptVisible(request("ask", "initial", null), UNKNOWN_VERDICT),
    ).toBe(true);
    expect(unknown.stopDisabled).toBe(false);

    const retry = describeHostQuitPrompt(
      request("ask", "busy-retry", "msg"),
      BUSY_VERDICT,
      LOCAL_HOST_ID,
    );
    expect(
      hostQuitPromptVisible(request("ask", "busy-retry", "msg"), BUSY_VERDICT),
    ).toBe(true);
    expect(retry.stopDisabled).toBe(false);
  });
});
