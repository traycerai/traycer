import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

interface CatalogueState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data: SandboxCatalogue | undefined;
  readonly error: Error | null;
  readonly refetch: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  catalogue: null as CatalogueState | null,
  toastSuccess: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: mocks.toastFromAuthError,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => mocks.catalogue,
}));

import { SandboxCreateDialog } from "@/components/hosts/sandbox-create-dialog";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxCreateDialogStore } from "@/stores/settings/sandbox-create-dialog-store";

const SHAPE = {
  cpuMin: 1,
  cpuMax: 16,
  cpuStep: 1,
  memoryPerCpuMinMb: 1024,
  memoryPerCpuMaxMb: 8192,
  memoryMinMb: 1024,
  memoryMaxMb: 65536,
  memoryStepMb: 512,
  diskMinMb: 10240,
  diskMaxMb: 102400,
  diskDefaultMb: 20480,
};

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: SHAPE,
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      dockerInGuest: true,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
        },
        {
          id: "eu-west",
          label: "EU West",
          fromPriceMcPerHour: { awakeMc: 150, suspendedMc: 5, stoppedMc: 3 },
        },
      ],
    },
  ],
};

function loaded(catalogue: SandboxCatalogue): CatalogueState {
  return {
    isPending: false,
    isError: false,
    data: catalogue,
    error: null,
    refetch: () => Promise.resolve(),
  };
}

function renderDialog(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  act(() => {
    useSandboxCreateDialogStore.getState().openDialog();
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxCreateDialog />
    </QueryClientProvider>,
  );
}

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submit(): HTMLElement {
  return screen.getByTestId("sandbox-create-submit");
}

beforeEach(() => {
  // The form loads its catalogue only for a signed-in user.
  useAuthStore.setState({ status: "signed-in" });
  mocks.binding = createFakeSandboxBinding();
  mocks.catalogue = loaded(CATALOGUE);
  mocks.toastSuccess.mockClear();
  mocks.toastFromAuthError.mockClear();
});
afterEach(() => {
  cleanup();
  act(() => {
    useSandboxCreateDialogStore.getState().closeDialog();
  });
  useAuthStore.setState({ status: "signed-out" });
});

describe("<SandboxCreateDialog />", () => {
  it("renders nothing of the form until it is opened", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SandboxCreateDialog />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("sandbox-create-dialog")).toBeNull();
  });

  it("starts at the smallest size, names the first region's from price and keeps Create disabled until it has a name", async () => {
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");

    expect(screen.getByTestId("sandbox-create-cpus")).toHaveProperty(
      "value",
      "1",
    );
    expect(screen.getByTestId("sandbox-create-memory")).toHaveProperty(
      "value",
      "1",
    );
    // The server's own default region is the first priced one.
    expect(screen.getByTestId("sandbox-create-price").textContent).toBe(
      "From 0.12 credits per hour awake in US East, for the smallest size; this size's exact rate shows on its card once it is created.",
    );
    expect(submit().hasAttribute("disabled")).toBe(true);

    type("sandbox-create-name", "   ");
    expect(submit().hasAttribute("disabled")).toBe(true);
    type("sandbox-create-name", "build-box");
    expect(submit().hasAttribute("disabled")).toBe(false);
  });

  it("sends the chosen shape, the default region and a non-burst request, and toasts the creation", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue({
      kind: "ok",
      accepted: {
        sandboxId: "sbx_1",
        hostId: "host-1",
        sandbox: sandboxSummaryFixture({ state: "creating" }),
      },
    });
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");

    type("sandbox-create-name", "  build-box ");
    type("sandbox-create-cpus", "2");
    type("sandbox-create-memory", "2.5");
    expect(submit().hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit());

    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });
    expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledWith({
      os: "linux",
      cpus: 2,
      memoryMb: 2560,
      diskMb: null,
      region: "us-east",
      displayName: "build-box",
      idleMinutes: 30,
      burst: false,
      createdByHostId: null,
      createdByAgentId: null,
    });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Created build-box");
    });
    await waitFor(() => {
      expect(useSandboxCreateDialogStore.getState().open).toBe(false);
    });
  });

  it("rounds an off-step size up, says so, and sends the rounded request instead of letting the browser block the submit", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue({
      kind: "ok",
      accepted: {
        sandboxId: "sbx_1",
        hostId: "host-1",
        sandbox: sandboxSummaryFixture({ state: "creating" }),
      },
    });
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");

    type("sandbox-create-name", "build-box");
    type("sandbox-create-cpus", "1.5");
    type("sandbox-create-memory", "2.1");
    expect(screen.getByTestId("sandbox-create-price").textContent).toContain(
      "Rounded to 2 vCPU and 2.5 GB.",
    );
    fireEvent.click(submit());

    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });
    expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ cpus: 2, memoryMb: 2560 }),
    );
  });

  it("replaces the price with the reason, and refuses to submit, for a shape outside the catalogue", async () => {
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");

    type("sandbox-create-cpus", "99");
    expect(screen.getByTestId("sandbox-create-shape-problem").textContent).toBe(
      "vCPU must be between 1 and 16.",
    );
    expect(screen.queryByTestId("sandbox-create-price")).toBeNull();
    expect(submit().hasAttribute("disabled")).toBe(true);

    fireEvent.submit(submit().closest("form") ?? submit());
    expect(mocks.binding?.auth.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and toasts the typed copy when the control plane refuses", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());

    await waitFor(() => {
      expect(mocks.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    const [error, title] = mocks.toastFromAuthError.mock.calls[0];
    expect(title).toBe("Couldn't create the sandbox.");
    expect(error.message).toBe(
      "Sandboxes aren't available right now. Try again later.",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(useSandboxCreateDialogStore.getState().open).toBe(true);
  });

  it("says sandboxes are not offered when no provider has a priced region", async () => {
    mocks.catalogue = loaded({
      providers: [{ ...CATALOGUE.providers[0], regions: [] }],
    });
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    expect(
      screen.getByText("Sandboxes aren't offered right now."),
    ).toBeDefined();
    expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();
  });

  it("holds the submit while a create runs after its dialog was closed and reopened, and toasts the creation once when it lands", async () => {
    let resolveCreate: (result: SandboxCreateFetchResult) => void = () =>
      undefined;
    mocks.binding?.auth.createSandbox.mockImplementation(
      () =>
        new Promise<SandboxCreateFetchResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());
    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });
    // The form that is creating shows its own spinner, not the in-flight line.
    expect(screen.queryByTestId("sandbox-create-in-flight")).toBeNull();

    act(() => {
      useSandboxCreateDialogStore.getState().closeDialog();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
    });
    act(() => {
      useSandboxCreateDialogStore.getState().openDialog();
    });

    // A fresh form, whose own mutation is idle, while the first still runs.
    await screen.findByTestId("sandbox-create-in-flight");
    expect(screen.getByTestId("sandbox-create-in-flight").textContent).toBe(
      "A sandbox is being created…",
    );
    type("sandbox-create-name", "second-box");
    expect(submit().hasAttribute("disabled")).toBe(true);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    // The form that sent it is long unmounted; the mutation still reports.
    await act(async () => {
      resolveCreate({
        kind: "ok",
        accepted: {
          sandboxId: "sbx_1",
          hostId: "host-1",
          sandbox: sandboxSummaryFixture({ state: "creating" }),
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Created build-box");
    expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-in-flight")).toBeNull();
    });
  });

  it("says to sign in, with no spinner, when the user is signed out", async () => {
    useAuthStore.setState({ status: "signed-out" });
    // A signed-out catalogue query is disabled and stays pending forever.
    mocks.catalogue = {
      isPending: true,
      isError: false,
      data: undefined,
      error: null,
      refetch: () => Promise.resolve(),
    };
    renderDialog();

    const line = await screen.findByTestId("sandbox-create-signed-out");
    expect(line.textContent).toBe("Sign in to create a sandbox.");
    expect(screen.queryByTestId("sandbox-create-loading")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();
  });

  it("shows the loading state while the catalogue is pending and a retry when it failed", async () => {
    mocks.catalogue = {
      isPending: true,
      isError: false,
      data: undefined,
      error: null,
      refetch: () => Promise.resolve(),
    };
    renderDialog();
    await screen.findByTestId("sandbox-create-loading");
    cleanup();

    const refetch = vi.fn<() => Promise<void>>(() => Promise.resolve());
    mocks.catalogue = {
      isPending: false,
      isError: true,
      data: undefined,
      error: new Error("Couldn't reach Traycer. Try again in a moment."),
      refetch,
    };
    renderDialog();
    await screen.findByText("Couldn't reach Traycer. Try again in a moment.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
