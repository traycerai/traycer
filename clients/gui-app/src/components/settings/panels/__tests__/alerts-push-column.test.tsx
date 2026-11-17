import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  IPushPermissionHost,
  PushPermissionState,
} from "@traycer-clients/shared/platform/runner-host";
import { AlertsSettingsPanel } from "@/components/settings/panels/alerts-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import {
  createPushPermissionDouble,
  doubleFor,
  type PushPermissionDouble,
} from "./push-permission-double";

afterEach(() => {
  cleanup();
});

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderAlertsWith(
  pushPermission: IPushPermissionHost,
  queryClient: QueryClient,
): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={createFakeRunnerHost({ pushPermission })}>
        <AlertsSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function renderAlerts(pushPermission: IPushPermissionHost): RenderResult {
  return renderAlertsWith(pushPermission, newQueryClient());
}

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

function signInAs(userId: string): void {
  act(() => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId, userName: userId, email: `${userId}@example.com` },
        { userId, username: userId },
        [],
      );
  });
}

describe("<AlertsSettingsPanel /> Push column", () => {
  beforeEach(() => {
    signInAs("user-a");
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it.each<PushPermissionState>(["prompt", "denied"])(
    "keeps every switch disabled while the permission is %s",
    async (initial) => {
      const permission = doubleFor(initial);
      renderAlerts(permission.host);

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
    renderAlerts(permission.host);

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
    renderAlerts(doubleFor("granted").host);

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
    renderAlerts(permission.host);

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
    renderAlerts(permission.host);
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
    renderAlerts(permission.host);
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

  async function switchToAccountB(
    permission: PushPermissionDouble,
  ): Promise<void> {
    permission.holdReads();
    permission.setAccount("user-b");
    signInAs("user-b");
    act(() => {
      permission.fireChange();
    });
    await waitFor(() => {
      for (const element of allSwitches()) {
        expect(element.hasAttribute("disabled")).toBe(true);
      }
    });
  }

  it("never shows the previous account's answer as editable after an identity switch", async () => {
    const permission = doubleFor("granted");
    permission.setStoredMuted(["done"]);
    renderAlerts(permission.host);
    await waitFor(() => {
      expect(isChecked(severitySwitch("Done"))).toBe(false);
    });
    expect(severitySwitch("Done").hasAttribute("disabled")).toBe(false);

    await switchToAccountB(permission);
    permission.releaseReads();

    await waitFor(() => {
      for (const element of allSwitches()) {
        expect(element.hasAttribute("disabled")).toBe(false);
      }
    });
    for (const element of allSwitches()) {
      expect(isChecked(element)).toBe(true);
    }
  });

  it("submits the new account's set when toggled after an identity switch", async () => {
    const permission = doubleFor("granted");
    permission.setStoredMuted(["done"]);
    renderAlerts(permission.host);
    await waitFor(() => {
      expect(isChecked(severitySwitch("Done"))).toBe(false);
    });
    await switchToAccountB(permission);
    permission.releaseReads();
    await waitFor(() => {
      expect(severitySwitch("Failure").hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(severitySwitch("Failure"));

    await waitFor(() => {
      expect(isChecked(severitySwitch("Failure"))).toBe(false);
    });
    expect(permission.setCalls).toEqual([["failure"]]);
  });

  it("keeps the switches disabled on a remount under another account until that account's read lands", async () => {
    const permission = doubleFor("granted");
    permission.setStoredMuted(["done"]);
    const queryClient = newQueryClient();
    const first = renderAlertsWith(permission.host, queryClient);
    await waitFor(() => {
      expect(isChecked(severitySwitch("Done"))).toBe(false);
    });
    first.unmount();

    permission.holdReads();
    permission.setAccount("user-b");
    signInAs("user-b");
    renderAlertsWith(permission.host, queryClient);

    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "registered",
      );
    });
    for (const element of allSwitches()) {
      expect(element.hasAttribute("disabled")).toBe(true);
    }

    permission.releaseReads();

    await waitFor(() => {
      for (const element of allSwitches()) {
        expect(element.hasAttribute("disabled")).toBe(false);
      }
    });
    for (const element of allSwitches()) {
      expect(isChecked(element)).toBe(true);
    }
  });
});
