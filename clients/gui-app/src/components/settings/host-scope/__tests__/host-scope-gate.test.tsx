import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
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
import { RunnerHostProvider } from "@/providers/runner-host-provider";

/** Concealed-or-absent: the gate's claim for children in a non-usable state. */
function expectHiddenFromView(node: Element | null): void {
  expect(node === null || isConcealed(node)).toBe(true);
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
  afterEach(cleanup);

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

  it("names the plan gate and offers Upgrade instead of claiming unreachable", async () => {
    // A plan-gated route is a billing fact: the host works on its own
    // machine and the server refuses the attach. Rendering it through the
    // generic unreachable notice sent people debugging connectivity over a
    // limit only an upgrade lifts.
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.example/sign-in",
      authnBaseUrl: "https://auth.example",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostScopeGate
            scope={hostScopeFixture({
              host: hostScopeOptionFixture({
                hostId: "host-b",
                name: "Office Linux",
                isLocalMachine: false,
                connectable: false,
                planRestricted: true,
              }),
              status: "unreachable",
            })}
            skeleton={<div data-testid="skeleton" />}
          >
            <div data-testid="body" />
          </HostScopeGate>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("host-scope-plan-restricted")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expectHiddenFromView(screen.queryByTestId("body"));

    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    await waitFor(() => {
      expect(runnerHost.openedExternalLinks.length).toBe(1);
    });
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

    expect(screen.getByTestId("host-scope-return-to-active")).not.toBeNull();
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

    expect(screen.getByTestId("host-scope-vanished")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-lists-failed")).toBeNull();
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
  afterEach(cleanup);

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
});
