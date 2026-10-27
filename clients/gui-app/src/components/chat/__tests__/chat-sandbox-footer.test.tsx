import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { ChatSandboxState } from "@/lib/sandboxes/chat-sandbox-state";

const h = vi.hoisted(() => ({
  mutate: vi.fn<(verb: string) => void>(),
  verbSandboxId: [] as string[],
  openDetails: vi.fn<(sandboxId: string) => void>(),
}));

vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: (sandboxId: string) => {
    h.verbSandboxId.push(sandboxId);
    return { mutate: h.mutate, isPending: false };
  },
}));
vi.mock("@/stores/sandboxes/sandbox-details-store", () => ({
  openSandboxDetails: h.openDetails,
}));

vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => undefined,
}));

import { ChatSandboxFooter } from "@/components/chat/chat-sandbox-footer";
import {
  sandboxFrozenLine,
  sandboxTeamFrozenStateLine,
} from "@/components/hosts/sandbox-card-model";
import { sandboxRowActionLabel } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";

const ENDED_AT = Date.UTC(2026, 9, 27, 6, 21);

function resting(
  state: "suspended" | "stopped",
  options: {
    readonly team: boolean;
    readonly wakeChangesPayer: boolean;
  },
): ChatSandboxState {
  return {
    kind: "resting",
    sandbox: sandboxSummaryFixture({
      id: "sbx-r",
      displayName: "e2e-sbx-rest",
      state,
      priceMcPerHour: { awakeMc: 210, suspendedMc: 4, stoppedMc: 2 },
    }),
    configuration: options.team
      ? { kind: "team", teamId: "team-a", teamName: "Acme" }
      : { kind: "personal" },
    wakeChangesPayer: options.wakeChangesPayer,
  };
}

function unreachable(lastContactMinutes: number | null): ChatSandboxState {
  return {
    kind: "unreachable",
    sandbox: sandboxSummaryFixture({
      id: "sbx-u",
      displayName: "e2e-sbx-live",
      state: "awake",
    }),
    lastContactMinutes,
  };
}

beforeEach(() => {
  h.mutate.mockReset();
  h.openDetails.mockReset();
  h.verbSandboxId.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("<ChatSandboxFooter /> a resting sandbox", () => {
  it.each([
    [
      "suspended",
      "e2e-sbx-rest is suspended · your next message resumes it · $0.21 an hour while awake · uses your credits",
    ],
    [
      "stopped",
      "e2e-sbx-rest is stopped · your next message starts it from a cold boot · $0.21 an hour while awake · uses your credits",
    ],
  ] as const)(
    "says a %s sandbox wakes on the next message, what it costs and whose credits",
    (state, line) => {
      render(
        <ChatSandboxFooter
          state={resting(state, { team: false, wakeChangesPayer: false })}
        />,
      );

      expect(document.body.textContent).toContain(line);
    },
  );

  it("adds the team clauses only when the wake changes who pays", () => {
    const { unmount } = render(
      <ChatSandboxFooter
        state={resting("suspended", { team: true, wakeChangesPayer: true })}
      />,
    );
    const paying = document.body.textContent;
    expect(paying).toContain("uses your Acme credits");
    expect(paying).toContain(
      "Storage while it rests, on the same credits until another member wakes it.",
    );
    expect(paying).toContain("Other members can use it while you pay.");
    unmount();

    render(
      <ChatSandboxFooter
        state={resting("suspended", { team: true, wakeChangesPayer: false })}
      />,
    );
    const same = document.body.textContent;
    expect(same).toContain("uses your Acme credits");
    expect(same).not.toContain("Storage while it rests");
    expect(same).not.toContain("Other members can use it");
  });

  it("offers no action and no offline or clone wording: the next message is the wake", () => {
    render(
      <ChatSandboxFooter
        state={resting("stopped", { team: false, wakeChangesPayer: false })}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /offline|clone|unreachable|destroyed/i,
    );
  });
});

describe("<ChatSandboxFooter /> a frozen sandbox", () => {
  const FROZEN_AT = Date.UTC(2026, 9, 20, 6, 21);

  function frozen(team: boolean): ChatSandboxState {
    const base = resting("suspended", { team, wakeChangesPayer: false });
    if (base.kind !== "resting") throw new Error("expected a resting state");
    return {
      ...base,
      sandbox: { ...base.sandbox, frozen: true, frozenAt: FROZEN_AT },
    };
  }

  it("says the personal sandbox is frozen out of credits instead of promising the next message wakes it, and offers Add credits", () => {
    render(<ChatSandboxFooter state={frozen(false)} />);

    const text = document.body.textContent;
    expect(text).toContain(sandboxFrozenLine(FROZEN_AT));
    expect(text).not.toContain("your next message resumes it");
    expect(
      screen.queryByRole("link", { name: /add credits/i }) ??
        screen.queryByRole("button", { name: /add credits/i }),
    ).not.toBeNull();
  });

  it("names whose bundle is out on a team sandbox and offers Resume using my team credits", () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: "viewer", userName: "V", email: "v@example.com" },
      contextMetadata: { userId: "viewer", username: "V" },
    });
    const state = frozen(true);
    if (state.kind !== "resting") throw new Error("expected a resting state");
    render(<ChatSandboxFooter state={state} />);

    expect(document.body.textContent).toContain(
      sandboxTeamFrozenStateLine(state.sandbox, "viewer"),
    );
    expect(
      screen.getByRole("button", {
        name: sandboxRowActionLabel("resume-paying", {
          kind: "team",
          teamId: "team-a",
          teamName: "Acme",
          environmentId: null,
        }),
      }),
    ).toBeTruthy();
  });
});

describe("<ChatSandboxFooter /> an awake sandbox that cannot be reached", () => {
  it("says it is running but not connected, with the last contact, and offers Stop and Details", async () => {
    render(<ChatSandboxFooter state={unreachable(7)} />);

    expect(document.body.textContent).toContain(
      "e2e-sbx-live is running, but Traycer can’t connect · last contact 7 min ago",
    );

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]?.[0]).toBe("stop");
    expect(h.verbSandboxId).toContain("sbx-u");

    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(h.openDetails).toHaveBeenCalledWith("sbx-u");
  });

  it("leaves the last contact out when none is known", () => {
    render(<ChatSandboxFooter state={unreachable(null)} />);

    const text = document.body.textContent;
    expect(text).toContain(
      "e2e-sbx-live is running, but Traycer can’t connect",
    );
    expect(text).not.toContain("last contact");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});

describe("<ChatSandboxFooter /> a destroyed sandbox", () => {
  const destroyed: ChatSandboxState = {
    kind: "destroyed",
    ended: {
      name: "e2e-sbx-stop3",
      end: {
        state: "destroyed",
        destroyedAt: ENDED_AT,
        cause: "resting",
        actor: null,
      },
    },
  };

  it("says what ended it and offers only Details, never Stop or a wake", () => {
    render(<ChatSandboxFooter state={destroyed} />);

    expect(document.body.textContent).toContain(
      "e2e-sbx-stop3 was destroyed on Oct 27 at 06:21 after its resting period.",
    );
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Details"]);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("opens the task-visible details through a real click", async () => {
    render(<ChatSandboxFooter state={destroyed} />);

    await userEvent.click(screen.getByRole("button", { name: "Details" }));

    const details = await screen.findByTestId("task-sandbox-end-details");
    expect(details.textContent).toContain("e2e-sbx-stop3");
    expect(details.textContent).toContain("Oct 27");
    expect(h.openDetails).not.toHaveBeenCalled();
  });
});

describe("<ChatSandboxFooter /> no sandbox state", () => {
  it("renders nothing", () => {
    const { container } = render(
      <ChatSandboxFooter state={{ kind: "none" }} />,
    );

    expect(container.textContent).toBe("");
  });
});
