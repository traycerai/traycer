const updateAction = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);
vi.mock("@/hooks/host/use-older-host-update", () => ({
  useOlderHostUpdate: () => ({
    update: updateAction.update,
    pending: false,
    remotePending: false,
    failure: null,
  }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-provisioning-progress", () => ({
  useHostProvisioningProgress: () => null,
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Concealed-or-absent: the gate's claim for children in a non-usable state. */
function expectHiddenFromView(node: Element | null): void {
  expect(node === null || isConcealed(node)).toBe(true);
}

const HOST_SCOPE_WRAPPING_ACTION_TOKENS = [
  "h-auto",
  "max-w-full",
  "min-w-0",
  "shrink",
  "whitespace-normal",
  "wrap-anywhere",
] as const;

function classTokens(element: Element): ReadonlySet<string> {
  return new Set(
    element.className.split(/\s+/).filter((token) => token.length > 0),
  );
}

function expectClassTokens(element: Element, tokens: readonly string[]): void {
  const present = classTokens(element);
  for (const token of tokens) {
    expect(present.has(token), token).toBe(true);
  }
}

/**
 * The gate is where "no hosts in hand" is turned into a sentence a person
 * reads, and the two ways of having none are not the same claim:
 *
 *   - the lists answered, and the account owns nothing → install one.
 *   - a list request FAILED → we do not know, and retrying is the fix.
 *
 * Collapsing them told people with hosts to go install a host.
 */
describe("<HostScopeGate /> empty and failed states", () => {
  afterEach(() => {
    cleanup();
    updateAction.update.mockClear();
  });

  it.each(["local", "remote"] as const)(
    "shows the update notice and working outline action for a picked %s host below the minimum",
    (kind) => {
      const entry =
        kind === "local"
          ? {
              ...mockLocalHostEntry,
              hostId: "picked-old-host",
              version: "1.5.4",
            }
          : (() => {
              const base = remoteEntry("picked-old-host", null);
              return {
                ...base,
                version: "2.0.0",
                remoteStatus: {
                  ...base.remoteStatus,
                  appVersion: "1.5.4",
                },
              };
            })();
      const host = hostScopeOptionFixture({
        hostId: entry.hostId,
        name: "Build Mac",
        isLocalMachine: kind === "local",
        entry,
      });

      render(
        <HostScopeGate
          scope={hostScopeFixture({ host, status: "following" })}
          skeleton={<div data-testid="skeleton" />}
        >
          <div data-testid="body" />
        </HostScopeGate>,
      );

      const notice = screen.getByTestId("host-scope-update-needed");
      expect(within(notice).getByText("Host update needed").textContent).toBe(
        "Host update needed",
      );
      expect(
        within(notice).getByText(
          "This host is running an older version than this app supports.",
        ).textContent,
      ).toBe("This host is running an older version than this app supports.");
      const update = screen.getByRole("button", { name: "Update now" });
      expect(update.textContent).toBe("Update now");
      expect(update.getAttribute("data-variant")).toBe("outline");
      expectHiddenFromView(screen.queryByTestId("body"));

      fireEvent.click(update);
      expect(updateAction.update).toHaveBeenCalledTimes(1);
    },
  );

  it("renders the panel body once the scope is ready", () => {
    render(
      <HostScopeGate
        scope={hostScopeFixture({ status: "ready" })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("body")).not.toBeNull();
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the ordinary unreachable notice for a remote host with no route, and nothing about a plan", () => {
    // Remote hosts are available on every plan, so a remote host this app has
    // no route to is only ever unreachable: the notice names the host, says
    // there is no live connection, and offers no purchase.
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-b",
            name: "Office Linux",
            isLocalMachine: false,
            connectable: false,
          }),
          status: "unreachable",
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    const notice = screen.getByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain("Can't reach Office Linux from here");
    expect(notice.textContent).toContain(
      "This host is in your account, but this app has no connection to it right now. Its status above is from your account, not a live link.",
    );
    expectClassTokens(notice, ["w-full", "min-w-0"]);
    expect(notice.textContent).not.toContain("plan");
    expect(screen.queryByRole("button", { name: "Upgrade plan" })).toBeNull();
    expect(screen.queryByTestId("host-scope-return-to-active")).toBeNull();
    expectHiddenFromView(screen.queryByTestId("body"));
  });

  it("renders the skeleton, not the body, while the scope is connecting", () => {
    render(
      <HostScopeGate
        scope={hostScopeFixture({ status: "connecting" })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("skeleton")).not.toBeNull();
    expectHiddenFromView(screen.queryByTestId("body"));
  });

  it("offers no return action when the unreachable host is already the active one", async () => {
    // Asking `connectable` before `isFollowing` made `unreachable` reachable
    // for the ACTIVE host, which turned this action into a no-op: "Back to X"
    // while already on X, calling `returnToActive` to clear an override that
    // is already null. Nothing changes, including the notice the user is
    // looking at. An action that cannot alter the state it is offered against
    // is worse than none — it reads as the way out.
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      name: "This Mac",
      isActive: true,
      connectable: false,
    });
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: active,
          hostId: active.hostId,
          status: "unreachable",
          activeHostId: active.hostId,
          activeHost: active,
          isViewingActive: true,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    // The explanation still renders — only the dead button is withheld.
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-return-to-active")).toBeNull();
    expectHiddenFromView(screen.queryByTestId("body"));
  });

  it("still offers the way back when the unreachable host is not the active one", async () => {
    // The counterweight: withholding the action for the active host must not
    // withhold it for a pick that genuinely has somewhere to return to.
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-picked",
            name: "Studio Linux",
            connectable: false,
          }),
          hostId: "host-picked",
          status: "unreachable",
          activeHostId: "host-active",
          activeHost: hostScopeOptionFixture({
            hostId: "host-active",
            name: "This Mac",
            isActive: true,
          }),
          isViewingActive: false,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    const back = screen.getByTestId("host-scope-return-to-active");
    expect(back.textContent).toBe("Back to This Mac");
    expectClassTokens(back, HOST_SCOPE_WRAPPING_ACTION_TOKENS);
    const notice = screen.getByTestId("host-scope-unreachable");
    expectClassTokens(notice, ["w-full", "min-w-0"]);
    expect(notice.textContent).toContain(
      "This host is in your account, but this app has no connection to it right now. Its status above is from your account, not a live link.",
    );
  });

  it("says the list failed, and offers a retry, rather than claiming an empty account", () => {
    const retryLists = vi.fn();
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          listsFailed: true,
          isLoading: false,
          retryLists,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("host-scope-lists-failed")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-empty")).toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryLists).toHaveBeenCalledTimes(1);
  });

  it("still claims an empty account when the lists genuinely answered", () => {
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          listsFailed: false,
          isLoading: false,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("host-scope-empty")).not.toBeNull();
    expect(screen.getByText("No hosts yet")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-lists-failed")).toBeNull();
  });

  it("reports a vanished pick ahead of a failed list", () => {
    // Precedence: a failing background list must not overwrite the more
    // specific verdict the user needs, which names the host they picked.
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          status: "vanished",
          vanishedHostId: "host-gone",
          hostLabel: "host-gone",
          listsFailed: true,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    const notice = screen.getByTestId("host-scope-vanished");
    expect(screen.queryByTestId("host-scope-lists-failed")).toBeNull();
    const back = screen.getByRole("button", {
      name: "Back to your active host",
    });
    expect(back.getAttribute("data-testid")).toBe(
      "host-scope-return-to-active",
    );
    expectClassTokens(back, HOST_SCOPE_WRAPPING_ACTION_TOKENS);
    expectClassTokens(notice, ["w-full", "min-w-0"]);
    expect(notice.textContent).toContain(
      "It was removed from your account, or signed out. Nothing here can act on it.",
    );
  });

  it("wraps Forget when the vanished host is one this screen still remembers", () => {
    const forget = vi.fn();
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          status: "vanished",
          vanishedHostId: "host-gone",
          vanishedSelection: { name: "Old workstation", forget },
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    const notice = screen.getByTestId("host-scope-vanished");
    expect(notice.textContent).toContain("Old workstation is no longer here.");
    expect(notice.textContent).not.toContain(
      "It was removed from your account, or signed out.",
    );
    expectClassTokens(notice, ["w-full", "min-w-0"]);
    const forgetButton = screen.getByRole("button", {
      name: "Forget Old workstation",
    });
    expect(forgetButton.getAttribute("data-testid")).toBe(
      "host-scope-forget-vanished",
    );
    expectClassTokens(forgetButton, HOST_SCOPE_WRAPPING_ACTION_TOKENS);
    fireEvent.click(forgetButton);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("body")).toBeNull();
  });
});

function TypedProbe() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Typed probe"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

function EffectProbe(props: { readonly log: string[] }) {
  const { log } = props;
  useEffect(() => {
    log.push("mount");
    return () => {
      log.push("cleanup");
    };
  }, [log]);
  return <div />;
}

/**
 * The gate's preservation contract: a non-usable state conceals children and
 * tears their side effects down, but their component state is only destroyed
 * by a REAL host switch — never by a transient same-host flap.
 */
describe("<HostScopeGate /> concealment and preservation", () => {
  afterEach(() => {
    cleanup();
    updateAction.update.mockClear();
  });

  function gateAt(
    status: "ready" | "unreachable",
    children: ReactNode,
    hostId: string,
  ) {
    return (
      <HostScopeGate
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({ hostId }),
          status,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        {children}
      </HostScopeGate>
    );
  }

  it("preserves typed state across a same-host unreachable flip", () => {
    const { rerender } = render(gateAt("ready", <TypedProbe />, "host-a"));
    fireEvent.change(screen.getByRole("textbox", { name: "Typed probe" }), {
      target: { value: "typed mid-flap" },
    });

    rerender(gateAt("unreachable", <TypedProbe />, "host-a"));
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
    // No role query can address the concealed probe — `display: none` drops
    // it from the accessibility tree and empties its accessible name — which
    // is itself the concealment working. The value query is the Testing
    // Library query that still reaches it.
    expectHiddenFromView(screen.queryByDisplayValue("typed mid-flap"));

    rerender(gateAt("ready", <TypedProbe />, "host-a"));
    const restored = screen.getByRole("textbox", { name: "Typed probe" });
    expect(restored instanceof HTMLInputElement ? restored.value : null).toBe(
      "typed mid-flap",
    );
    expect(isConcealed(restored)).toBe(false);
  });

  it("destroys children state when the scope moves to another host", () => {
    const { rerender } = render(gateAt("ready", <TypedProbe />, "host-a"));
    fireEvent.change(screen.getByRole("textbox", { name: "Typed probe" }), {
      target: { value: "belongs to host-a" },
    });

    rerender(gateAt("ready", <TypedProbe />, "host-b"));
    // The remounted probe is FRESH — present, but with host-a's typing gone.
    const fresh = screen.getByRole("textbox", { name: "Typed probe" });
    expect(fresh instanceof HTMLInputElement ? fresh.value : null).toBe("");
  });

  it("tears children effects down while concealed and remounts them on return", () => {
    // This is the side-effect half of the honest-state claim: a concealed
    // panel's subscriptions (queries, sockets) are OFF, not merely invisible.
    const log: string[] = [];
    const { rerender } = render(
      gateAt("ready", <EffectProbe log={log} />, "host-a"),
    );
    expect(log).toEqual(["mount"]);

    rerender(gateAt("unreachable", <EffectProbe log={log} />, "host-a"));
    expect(log).toEqual(["mount", "cleanup"]);

    rerender(gateAt("ready", <EffectProbe log={log} />, "host-a"));
    expect(log).toEqual(["mount", "cleanup", "mount"]);
  });

  it("un-presents an open portaled surface while concealed and re-presents it", () => {
    // A portal's DOM escapes the hidden Activity's styling entirely (it hangs
    // off document.body, and React conceals only the topmost in-tree host
    // nodes), so without the concealment context an open popover, menu, or
    // select would float above the unreachable notice with its dismissal
    // effects torn down — visible, interactive, and unclosable. The popover
    // stands in for the class here; the dialog variant is covered end-to-end
    // in the notifications panel suite.
    const surface = (
      <Popover open>
        <PopoverTrigger>anchor</PopoverTrigger>
        <PopoverContent>
          <div data-testid="portal-surface">floating content</div>
        </PopoverContent>
      </Popover>
    );
    const { rerender } = render(gateAt("ready", surface, "host-a"));
    expect(screen.getByTestId("portal-surface")).not.toBeNull();

    rerender(gateAt("unreachable", surface, "host-a"));
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
    expect(screen.queryByTestId("portal-surface")).toBeNull();

    rerender(gateAt("ready", surface, "host-a"));
    expect(screen.getByTestId("portal-surface")).not.toBeNull();
  });

  it("hides a below-minimum host's controls and effects while preserving its draft for recovery", () => {
    const log: string[] = [];
    const localHost = (version: string) =>
      hostScopeOptionFixture({
        hostId: "host-floor-transition",
        entry: {
          ...mockLocalHostEntry,
          hostId: "host-floor-transition",
          version,
        },
      });
    const scopeAt = (version: string) =>
      hostScopeFixture({
        host: localHost(version),
        status: "following",
      });
    const surface = (
      <>
        <TypedProbe />
        <EffectProbe log={log} />
        <Popover open>
          <PopoverTrigger>anchor</PopoverTrigger>
          <PopoverContent>
            <button type="button" data-testid="portal-control">
              Change setting
            </button>
          </PopoverContent>
        </Popover>
      </>
    );
    const renderAt = (version: string) => (
      <HostScopeGate
        scope={scopeAt(version)}
        skeleton={<div data-testid="skeleton" />}
      >
        {surface}
      </HostScopeGate>
    );
    const { rerender } = render(renderAt("2.0.0"));
    fireEvent.change(screen.getByRole("textbox", { name: "Typed probe" }), {
      target: { value: "keep this draft" },
    });
    expect(screen.getByTestId("portal-control")).not.toBeNull();
    expect(log).toEqual(["mount"]);

    rerender(renderAt("1.5.4"));

    expect(screen.getByText("Host update needed")).not.toBeNull();
    expectHiddenFromView(screen.queryByDisplayValue("keep this draft"));
    expect(screen.queryByRole("button", { name: "Change setting" })).toBeNull();
    expect(screen.queryByTestId("portal-control")).toBeNull();
    expect(log).toEqual(["mount", "cleanup"]);

    rerender(renderAt("2.0.1"));

    expect(screen.getByDisplayValue("keep this draft")).not.toBeNull();
    expect(screen.getByTestId("portal-control")).not.toBeNull();
    expect(log).toEqual(["mount", "cleanup", "mount"]);
  });
});
