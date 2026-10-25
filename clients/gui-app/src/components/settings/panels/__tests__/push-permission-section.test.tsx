import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type {
  IPushPermissionHost,
  PushPermissionState,
  PushSeverity,
} from "@traycer-clients/shared/platform/runner-host";
import { PushPermissionSection } from "@/components/settings/panels/push-permission-section";
import { createAppQueryClient } from "@/lib/query-client";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

interface PushPermissionDouble {
  readonly host: IPushPermissionHost;
  readonly calls: {
    get: number;
    request: number;
    openSettings: number;
  };
  /** Move the OS's answer without telling the GUI - as the OS itself does. */
  readonly setState: (next: PushPermissionState) => void;
  /** The host's "this MAY have changed, re-read it" edge. */
  readonly fireChange: () => void;
  /** Lets a deferred `openSettings()` finish, ending the pending state. */
  readonly resolveOpenSettings: () => void;
  /** Each `setMutedSeverities` call's set, in call order. */
  readonly setCalls: PushSeverity[][];
  /** What the phone has stored; moves only when a set call has finished. */
  readonly setStoredMuted: (next: readonly PushSeverity[]) => void;
  /** Holds the next `setMutedSeverities` unresolved until `releaseSet()`. */
  readonly holdNextSet: () => void;
  readonly releaseSet: () => void;
}

/**
 * Stands in for the phone's `IPushPermissionHost`. It behaves like the OS in
 * the one way that matters here: `onChange` carries no state, so a subscriber
 * only learns the new value by asking again.
 */
function createPushPermissionDouble(options: {
  readonly initial: PushPermissionState;
  /** State `request()` resolves with, i.e. what the OS prompt returned. */
  readonly requestResolvesWith: PushPermissionState;
  readonly getRejectsWith: string | null;
  /**
   * Hold `openSettings()` unresolved until `resolveOpenSettings()`. Jumping to
   * the OS Settings app is the slowest thing this row does, so it is where the
   * pending UX actually shows up.
   */
  readonly deferOpenSettings: boolean;
}): PushPermissionDouble {
  const calls = { get: 0, request: 0, openSettings: 0 };
  const handlers = new Set<() => void>();
  let state = options.initial;
  let releaseOpenSettings: () => void = () => undefined;
  const openSettingsGate = new Promise<void>((resolve) => {
    releaseOpenSettings = resolve;
  });
  const setCalls: PushSeverity[][] = [];
  let storedMuted: readonly PushSeverity[] = [];
  let setGate: Promise<void> | null = null;
  let releaseSetGate: () => void = () => undefined;
  const host: IPushPermissionHost = {
    get: () => {
      calls.get += 1;
      if (options.getRejectsWith !== null) {
        return Promise.reject(new Error(options.getRejectsWith));
      }
      return Promise.resolve(state);
    },
    request: () => {
      calls.request += 1;
      state = options.requestResolvesWith;
      return Promise.resolve(state);
    },
    openSettings: () => {
      calls.openSettings += 1;
      if (options.deferOpenSettings) return openSettingsGate;
      return Promise.resolve();
    },
    getMutedSeverities: () => Promise.resolve(storedMuted),
    // Like the phone: store the set, then say "re-read" through `onChange`.
    setMutedSeverities: async (set) => {
      setCalls.push([...set]);
      if (setGate !== null) await setGate;
      storedMuted = [...set];
      for (const handler of Array.from(handlers)) handler();
    },
    onChange: (handler) => {
      handlers.add(handler);
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
  };
  return {
    host,
    calls,
    setState: (next) => {
      state = next;
    },
    fireChange: () => {
      for (const handler of handlers) handler();
    },
    resolveOpenSettings: () => {
      releaseOpenSettings();
    },
    setCalls,
    setStoredMuted: (next) => {
      storedMuted = next;
    },
    holdNextSet: () => {
      setGate = new Promise<void>((resolve) => {
        releaseSetGate = resolve;
      });
    },
    releaseSet: () => {
      releaseSetGate();
    },
  };
}

function renderSectionWith(
  pushPermission: IPushPermissionHost | null,
  queryClient: QueryClient,
): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={createFakeRunnerHost({ pushPermission })}>
        <PushPermissionSection />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function renderSection(
  pushPermission: IPushPermissionHost | null,
): RenderResult {
  return renderSectionWith(
    pushPermission,
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    }),
  );
}

function doubleFor(initial: PushPermissionState): PushPermissionDouble {
  return createPushPermissionDouble({
    initial,
    requestResolvesWith: initial,
    getRejectsWith: null,
    deferOpenSettings: false,
  });
}

afterEach(() => {
  cleanup();
});

describe("<PushPermissionSection />", () => {
  // A host-less shell has no runner host at all, and every hook the group
  // uses reaches for one — so the gate has to return before any of them run.
  it("renders nothing, and does not throw, with no runner host above it", () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <PushPermissionSection />
      </QueryClientProvider>,
    );

    expect(view.container.innerHTML).toBe("");
  });

  it("renders nothing where the shell has no OS push permission", () => {
    renderSection(null);

    expect(screen.queryByText("Push notifications on this phone")).toBeNull();
    expect(screen.queryByTestId("push-permission-state")).toBeNull();
  });

  it("reports a granted permission with no control to act on", async () => {
    const permission = doubleFor("granted");
    renderSection(permission.host);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByText("Push notifications on this phone")).toBeTruthy();
    expect(
      screen.getByText(
        "Delivered to this phone for the events turned on under Notification events.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "granted",
    );
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });

  it("names system Settings as the repair when the OS has refused", async () => {
    const permission = doubleFor("denied");
    renderSection(permission.host);

    const action = await screen.findByRole("button", {
      name: "Open Settings",
    });
    expect(action.dataset.testid).toBe("push-permission-action");
    expect(
      screen.getByText("Turned off for Traycer in system Settings."),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "denied",
    );
    expect(screen.queryByText("On")).toBeNull();
  });

  it("offers the prompt itself while the OS still allows one", async () => {
    const permission = doubleFor("prompt");
    renderSection(permission.host);

    const action = await screen.findByRole("button", { name: "Enable" });
    expect(action.dataset.testid).toBe("push-permission-action");
    expect(
      screen.getByText(
        "Get buzzed on this phone for the events turned on under Notification events.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "prompt",
    );
  });

  it("shows the read failure instead of guessing a state", async () => {
    const permission = createPushPermissionDouble({
      initial: "denied",
      requestResolvesWith: "denied",
      getRejectsWith: "permission read failed",
      deferOpenSettings: false,
    });
    renderSection(permission.host);

    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "error",
      );
    });
    expect(
      screen.getByText(
        "Couldn't read this phone's notification setting. permission read failed",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });

  it("opens the OS notification page exactly once per tap", async () => {
    const permission = doubleFor("denied");
    renderSection(permission.host);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings" }),
    );

    await waitFor(() => {
      expect(permission.calls.openSettings).toBe(1);
    });
    expect(permission.calls.request).toBe(0);
  });

  it("re-reads after a granted prompt rather than trusting the button", async () => {
    const permission = createPushPermissionDouble({
      initial: "prompt",
      requestResolvesWith: "granted",
      getRejectsWith: null,
      deferOpenSettings: false,
    });
    renderSection(permission.host);

    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() => {
      expect(permission.calls.request).toBe(1);
    });
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "granted",
    );
    expect(screen.queryByTestId("push-permission-action")).toBeNull();
  });

  it("follows a permission changed outside the app, with nothing tapped here", async () => {
    // The whole point of Fix B's `onChange`: the person leaves for the OS
    // Settings app, flips the switch, and comes back. Nothing in this GUI was
    // touched, and the row must not still say the app is muted.
    const permission = doubleFor("denied");
    renderSection(permission.host);

    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "denied",
      );
    });

    permission.setState("granted");
    permission.fireChange();

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
      "granted",
    );
  });

  it("re-reads the OS on every mount, never serving a cached permission", async () => {
    // Built on the REAL app query client: its 60s `staleTime` is the whole
    // point. The `onChange` subscription is disposed while this row is
    // unmounted, so nothing invalidates in between - leave a person to change
    // the switch in the OS Settings app between two visits to Sounds
    // and a cached answer would show them "Off · Open Settings" on a phone
    // where push is already on.
    const permission = doubleFor("denied");
    const queryClient = createAppQueryClient();

    const first = renderSectionWith(permission.host, queryClient);
    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "denied",
      );
    });
    first.unmount();

    // The OS moves with no one listening, and nothing fires `onChange`.
    permission.setState("granted");
    const readsBeforeRemount = permission.calls.get;

    renderSectionWith(permission.host, queryClient);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(permission.calls.get).toBeGreaterThan(readsBeforeRemount);
  });

  it("holds the action disabled, labelled, and spinning while it is in flight", async () => {
    const permission = createPushPermissionDouble({
      initial: "denied",
      requestResolvesWith: "denied",
      getRejectsWith: null,
      deferOpenSettings: true,
    });
    renderSection(permission.host);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings" }),
    );

    // Pending UX per AGENTS.md: disabled, the SAME label (never "Opening…"),
    // and an inline spinner - so the button is still findable by its name.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /Open Settings/ })
          .hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(screen.getByTestId("push-permission-action-spinner")).toBeTruthy();

    permission.resolveOpenSettings();

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /Open Settings/ })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.queryByTestId("push-permission-action-spinner")).toBeNull();
  });
});

const SWITCH_LABELS = ["Needs action", "Failure", "Done", "Info"] as const;

function severitySwitch(label: string): HTMLElement {
  return screen.getByRole("switch", { name: `${label} push notifications` });
}

function allSwitches(): HTMLElement[] {
  return SWITCH_LABELS.map(severitySwitch);
}

function isChecked(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true";
}

describe("<PushPermissionSection /> severity switches", () => {
  it("draws no switches where the shell has no OS push permission", () => {
    renderSection(null);

    expect(screen.queryAllByRole("switch")).toEqual([]);
  });

  it.each<PushPermissionState>(["prompt", "denied"])(
    "keeps every switch disabled while the permission is %s",
    async (initial) => {
      const permission = doubleFor(initial);
      renderSection(permission.host);

      await waitFor(() => {
        expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
          initial,
        );
      });
      for (const element of allSwitches()) {
        expect(element.hasAttribute("disabled")).toBe(true);
      }
    },
  );

  it("keeps every switch disabled when the permission read failed", async () => {
    const permission = createPushPermissionDouble({
      initial: "granted",
      requestResolvesWith: "granted",
      getRejectsWith: "permission read failed",
      deferOpenSettings: false,
    });
    renderSection(permission.host);

    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "error",
      );
    });
    for (const element of allSwitches()) {
      expect(element.hasAttribute("disabled")).toBe(true);
    }
  });

  it("enables all four switches once granted and loaded, checked when nothing is muted", async () => {
    renderSection(doubleFor("granted").host);

    await waitFor(() => {
      for (const element of allSwitches()) {
        expect(element.hasAttribute("disabled")).toBe(false);
      }
    });
    for (const element of allSwitches()) {
      expect(isChecked(element)).toBe(true);
    }
  });

  it("shows a muted severity unchecked and the rest checked", async () => {
    const permission = doubleFor("granted");
    permission.setStoredMuted(["done"]);
    renderSection(permission.host);

    await waitFor(() => {
      expect(isChecked(severitySwitch("Done"))).toBe(false);
    });
    expect(isChecked(severitySwitch("Needs action"))).toBe(true);
    expect(isChecked(severitySwitch("Failure"))).toBe(true);
    expect(isChecked(severitySwitch("Info"))).toBe(true);
  });

  it("sends the full new set once on a toggle, then shows the stored value", async () => {
    const permission = doubleFor("granted");
    permission.setStoredMuted(["done"]);
    renderSection(permission.host);
    await waitFor(() => {
      expect(severitySwitch("Failure").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(severitySwitch("Failure"));

    await waitFor(() => {
      expect(isChecked(severitySwitch("Failure"))).toBe(false);
    });
    expect(permission.setCalls).toHaveLength(1);
    expect([...permission.setCalls[0]].sort()).toEqual(["done", "failure"]);
    expect(isChecked(severitySwitch("Done"))).toBe(false);
  });

  it("holds the switches disabled and unchanged while a set is pending", async () => {
    const permission = doubleFor("granted");
    renderSection(permission.host);
    await waitFor(() => {
      expect(severitySwitch("Failure").hasAttribute("disabled")).toBe(false);
    });
    permission.holdNextSet();

    fireEvent.click(severitySwitch("Failure"));

    await waitFor(() => {
      expect(severitySwitch("Failure").hasAttribute("disabled")).toBe(true);
    });
    for (const label of SWITCH_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
      expect(severitySwitch(label).hasAttribute("disabled")).toBe(true);
    }
    // Not yet stored, so not yet shown as changed.
    expect(isChecked(severitySwitch("Failure"))).toBe(true);

    permission.releaseSet();

    await waitFor(() => {
      expect(isChecked(severitySwitch("Failure"))).toBe(false);
    });
    expect(severitySwitch("Failure").hasAttribute("disabled")).toBe(false);
  });
});
