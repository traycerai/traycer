import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastSuccess: vi.fn<(message: string) => void>(),
  toastInfo: vi.fn<(message: string) => void>(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
}));

// These cases are about the preview features' on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, info: mocks.toastInfo },
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: mocks.toastFromAuthError,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => ({ sandboxControlUnavailableReason: null }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));

import { AutomationsHostEntry } from "@/components/hosts/automations-host-entry";

const OPENED = {
  kind: "ok",
  sandbox: sandboxSummaryFixture({ kind: "automation" }),
} as const;

function renderEntry(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AutomationsHostEntry />
    </QueryClientProvider>,
  );
}

function offered(available: boolean, withRow: boolean): void {
  mocks.binding?.auth.getSandboxAutomation.mockResolvedValue({
    kind: "ok",
    automation: {
      available,
      sandbox: withRow ? sandboxSummaryFixture({ kind: "automation" }) : null,
      pods: [],
    },
  });
}

/** Lets the read settle, so a "renders nothing" check is not a loading frame. */
async function readSettled(): Promise<void> {
  await waitFor(() => {
    expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.toastSuccess.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastFromAuthError.mockClear();
  useAuthStore.setState({ status: "signed-in" });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("<AutomationsHostEntry />", () => {
  it("shows Automations, a Released badge and Start when offered with no row", async () => {
    offered(true, false);
    renderEntry();

    const entry = await screen.findByTestId("settings-automations-entry");
    expect(entry.textContent).toContain("Automations");
    expect(
      screen.getByTestId("settings-automations-entry-state").textContent,
    ).toBe("Released");
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
  });

  it("renders nothing when the deployment does not offer Automations", async () => {
    offered(false, false);
    renderEntry();
    await readSettled();
    expect(screen.queryByTestId("settings-automations-entry")).toBeNull();
  });

  it("renders nothing once a row exists: the host list carries the real one", async () => {
    offered(true, true);
    renderEntry();
    await readSettled();
    expect(screen.queryByTestId("settings-automations-entry")).toBeNull();
  });

  it("renders nothing while the read is pending", () => {
    mocks.binding?.auth.getSandboxAutomation.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderEntry();
    expect(screen.queryByTestId("settings-automations-entry")).toBeNull();
  });

  it("renders nothing, and does not toast, when the read fails", async () => {
    mocks.binding?.auth.getSandboxAutomation.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    renderEntry();
    await readSettled();
    expect(screen.queryByTestId("settings-automations-entry")).toBeNull();
    expect(mocks.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("Start opens through openSandboxAutomation, once, and toasts started on 200", async () => {
    offered(true, false);
    mocks.binding?.auth.openSandboxAutomation.mockResolvedValue({
      ...OPENED,
      settled: true,
    });
    renderEntry();

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Automations started");
    });
    expect(mocks.binding?.auth.openSandboxAutomation).toHaveBeenCalledTimes(1);
    // The person's own host: no team environment, no pod to name.
    expect(mocks.binding?.auth.openSandboxAutomation).toHaveBeenCalledWith(
      null,
    );
    expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledWith(null);
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
    expect(mocks.binding?.directory.refresh).toHaveBeenCalledTimes(1);
  });

  it("says Starting… on 202", async () => {
    offered(true, false);
    mocks.binding?.auth.openSandboxAutomation.mockResolvedValue({
      ...OPENED,
      settled: false,
    });
    renderEntry();

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith("Starting Automations…");
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts the failure under the Automations title when the open is refused", async () => {
    offered(true, false);
    mocks.binding?.auth.openSandboxAutomation.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    renderEntry();

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(mocks.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastFromAuthError.mock.calls[0][1]).toBe(
      "Couldn't start Automations.",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("disables Start while the open is in flight", async () => {
    offered(true, false);
    mocks.binding?.auth.openSandboxAutomation.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderEntry();

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-automations-entry-start")
          .hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(
      screen.getByTestId("settings-automations-entry-start-spinner"),
    ).toBeDefined();
  });
});
