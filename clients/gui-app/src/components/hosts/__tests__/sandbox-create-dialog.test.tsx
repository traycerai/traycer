import type { ReactNode } from "react";
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
import userEvent from "@testing-library/user-event";
import {
  SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY,
  type SandboxCatalogue,
  type SandboxCatalogueProvider,
} from "@traycer/protocol/host/sandbox-control";
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
// The form reads the person's teams for Belongs to; this suite is a person
// in none, and `belongs-to` covers the rest.
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
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
      creatable: true,
      notCreatableReason: null,
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
  act(() => {
    useSandboxCreateDialogStore.getState().openDialog(null, null);
  });
  mountDialog();
}

/** Mounts the dialog without touching the store, as a second copy would. */
function mountDialog(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
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
  // `closeDialog` keeps the draft and the failure for the next open to clear;
  // nothing from one case may reach the next.
  useSandboxCreateDialogStore.setState({
    open: false,
    preselect: null,
    workingHostTeamId: null,
    draft: null,
    failure: null,
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
      environmentId: null,
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

  it("keeps the dialog open and says the typed copy in the form when the control plane refuses", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());

    const line = await screen.findByTestId("sandbox-create-failure");
    expect(line.textContent).toBe(
      "Sandboxes aren't available right now. Try again later.",
    );
    expect(mocks.toastFromAuthError).not.toHaveBeenCalled();
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
      useSandboxCreateDialogStore.getState().openDialog(null, null);
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

describe("a failed create", () => {
  it("keeps the entered values and shows the failure in the form", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue(
      refusal(502, "provider_failed"),
    );
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    type("sandbox-create-memory", "4");
    fireEvent.click(submit());

    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The sandbox failed to start. It's listed as failed; destroy it and try again.",
    );
    expect(screen.getByTestId("sandbox-create-name")).toHaveProperty(
      "value",
      "build-box",
    );
    expect(screen.getByTestId("sandbox-create-memory")).toHaveProperty(
      "value",
      "4",
    );
    expect(submit().hasAttribute("disabled")).toBe(false);
    expect(useSandboxCreateDialogStore.getState().open).toBe(true);
  });

  it("keeps what was typed when the form remounts while the dialog is open", async () => {
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    type("sandbox-create-memory", "4");

    // The store stays open: this is what the second dialog copy (settings
    // sidebar vs the phone-width surface) or a loading gate does.
    cleanup();
    expect(useSandboxCreateDialogStore.getState().open).toBe(true);
    mountDialog();
    await screen.findByTestId("sandbox-create-dialog");

    expect(screen.getByTestId("sandbox-create-name")).toHaveProperty(
      "value",
      "build-box",
    );
    expect(screen.getByTestId("sandbox-create-memory")).toHaveProperty(
      "value",
      "4",
    );
  });

  it("still toasts a failure when the dialog was closed before the create settled", async () => {
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

    act(() => {
      useSandboxCreateDialogStore.getState().closeDialog();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
    });

    await act(async () => {
      resolveCreate(refusal(502, "provider_failed"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a create's outcome goes to the open that sent it", () => {
  const CREATED: SandboxCreateFetchResult = {
    kind: "ok",
    accepted: {
      sandboxId: "sbx_1",
      hostId: "host-1",
      sandbox: sandboxSummaryFixture({ state: "creating" }),
    },
  };

  /** Makes the next create wait until the returned function settles it. */
  function deferCreate(): (result: SandboxCreateFetchResult) => Promise<void> {
    let resolveCreate: (result: SandboxCreateFetchResult) => void = () =>
      undefined;
    mocks.binding?.auth.createSandbox.mockImplementation(
      () =>
        new Promise<SandboxCreateFetchResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    return async (result) => {
      await act(async () => {
        resolveCreate(result);
        await Promise.resolve();
      });
    };
  }

  function dialogOn(queryClient: QueryClient): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <SandboxCreateDialog />
      </QueryClientProvider>
    );
  }

  it("toasts a failure that settles after the dialog was closed and reopened, and keeps it out of the new open", async () => {
    const settle = deferCreate();
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());
    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useSandboxCreateDialogStore.getState().closeDialog();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
    });
    act(() => {
      useSandboxCreateDialogStore.getState().openDialog(null, null);
    });
    await screen.findByTestId("sandbox-create-name");

    await settle(refusal(502, "provider_failed"));

    // The create was sent by the first open: its failure is a toast, and the
    // second open, which sent nothing, shows no failure line.
    await waitFor(() => {
      expect(mocks.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("sandbox-create-failure")).toBeNull();
  });

  it("closes the dialog for a create that succeeds after the form remounted, rather than leaving Create enabled over the sent values", async () => {
    const settle = deferCreate();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    act(() => {
      useSandboxCreateDialogStore.getState().openDialog(null, null);
    });
    render(dialogOn(queryClient));
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());
    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });

    // The store stays open, as for a second dialog copy or a loading gate.
    cleanup();
    expect(useSandboxCreateDialogStore.getState().open).toBe(true);
    render(dialogOn(queryClient));
    await screen.findByTestId("sandbox-create-dialog");
    expect(screen.getByTestId("sandbox-create-name")).toHaveProperty(
      "value",
      "build-box",
    );

    await settle(CREATED);
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Created build-box");
    });

    // The create the form sent has landed (Personal, so nothing follows it):
    // no enabled Create may be left over the values that were already sent.
    expect(useSandboxCreateDialogStore.getState().open).toBe(false);
  });

  it("a close and a new open brings back empty values and no failure line", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());
    await screen.findByTestId("sandbox-create-failure");

    act(() => {
      useSandboxCreateDialogStore.getState().closeDialog();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
    });
    act(() => {
      useSandboxCreateDialogStore.getState().openDialog(null, null);
    });
    await screen.findByTestId("sandbox-create-name");

    expect(screen.getByTestId("sandbox-create-name")).toHaveProperty(
      "value",
      "",
    );
    expect(screen.queryByTestId("sandbox-create-failure")).toBeNull();
  });

  it("a new open while the dialog is still open brings back empty values and no failure line", async () => {
    mocks.binding?.auth.createSandbox.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());
    await screen.findByTestId("sandbox-create-failure");

    act(() => {
      useSandboxCreateDialogStore.getState().openDialog(null, null);
    });

    expect(screen.queryByTestId("sandbox-create-failure")).toBeNull();
    expect(screen.getByTestId("sandbox-create-name")).toHaveProperty(
      "value",
      "",
    );
  });

  it("still says a failure on screen when the catalogue read failed while the create ran", async () => {
    const settle = deferCreate();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    act(() => {
      useSandboxCreateDialogStore.getState().openDialog(null, null);
    });
    const view = render(dialogOn(queryClient));
    await screen.findByTestId("sandbox-create-dialog");
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());
    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });

    // A background refetch of the catalogue fails: the body swaps the form
    // for the retry gate while the create is still running.
    mocks.catalogue = {
      isPending: false,
      isError: true,
      data: undefined,
      error: new Error("Couldn't reach Traycer. Try again in a moment."),
      refetch: () => Promise.resolve(),
    };
    view.rerender(dialogOn(queryClient));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByTestId("sandbox-create-name")).toBeNull();

    await settle(refusal(502, "provider_failed"));

    // The dialog is open and the create failed: the person must be told
    // somewhere they can see, even though the form is not on screen.
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-create-failure")).toBeDefined();
    });
  });
});

describe("a provider the account's plan cannot create", () => {
  const REGION = {
    id: "us-east",
    label: "US East",
    fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
  };

  function provider(
    os: SandboxCatalogueProvider["os"],
    creatable: boolean,
    notCreatableReason: string | null,
    memoryMaxMb: number,
  ): SandboxCatalogueProvider {
    return {
      provider: "tensorlake",
      os,
      shape: { ...SHAPE, memoryMinMb: 2048, memoryMaxMb },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      dockerInGuest: true,
      creatable,
      notCreatableReason,
      regions: [REGION],
    };
  }

  async function openWith(
    providers: SandboxCatalogue["providers"],
  ): Promise<void> {
    mocks.catalogue = loaded({ providers });
    renderDialog();
    await screen.findByTestId("sandbox-create-dialog");
  }

  function expectFormGone(): void {
    expect(screen.queryByTestId("sandbox-create-cpus")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-memory")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-price")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();
  }

  it("replaces the size inputs, price and Create with the generic line when the plan's memory is too small", async () => {
    await openWith([
      provider(
        ["linux"],
        false,
        SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY,
        1024,
      ),
    ]);

    // Nothing about the plan is the person's to change, so the line says
    // only that sandboxes can't be created here.
    expect(screen.getByTestId("sandbox-create-not-creatable").textContent).toBe(
      "Sandboxes can't be created on this account right now.",
    );
    expectFormGone();
    expect(
      screen.getByRole("combobox", { name: "Operating system" }),
    ).toBeDefined();
  });

  it("says a generic line for a reason this build does not know", async () => {
    await openWith([provider(["linux"], false, "something-new", 1024)]);

    expect(screen.getByTestId("sandbox-create-not-creatable").textContent).toBe(
      "Sandboxes can't be created on this account right now.",
    );
    expectFormGone();
  });

  it("says the generic line when no reason came", async () => {
    await openWith([provider(["linux"], false, null, 1024)]);

    expect(screen.getByTestId("sandbox-create-not-creatable").textContent).toBe(
      "Sandboxes can't be created on this account right now.",
    );
    expectFormGone();
  });

  it("brings the size inputs and Create back when the OS is switched to a creatable provider", async () => {
    await openWith([
      provider(
        ["linux"],
        false,
        SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY,
        1024,
      ),
      provider(["windows"], true, null, 65536),
    ]);
    expect(screen.getByTestId("sandbox-create-not-creatable")).toBeDefined();
    expectFormGone();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Windows" }));

    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-not-creatable")).toBeNull();
    });
    expect(screen.getByTestId("sandbox-create-cpus")).toBeDefined();
    expect(screen.getByTestId("sandbox-create-memory")).toBeDefined();
    expect(screen.getByTestId("sandbox-create-price")).toBeDefined();
    expect(submit()).toBeDefined();
  });

  it("still says a sandbox is being created when the OS is switched to the not-creatable provider while a create runs", async () => {
    let resolveCreate: (result: SandboxCreateFetchResult) => void = () =>
      undefined;
    mocks.binding?.auth.createSandbox.mockImplementation(
      () =>
        new Promise<SandboxCreateFetchResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    await openWith([
      provider(
        ["linux"],
        false,
        SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY,
        1024,
      ),
      provider(["windows"], true, null, 65536),
    ]);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Windows" }));
    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-create-not-creatable")).toBeNull();
    });
    type("sandbox-create-name", "win-box");
    fireEvent.click(submit());
    await waitFor(() => {
      expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
    });

    // The create is still running; the person flips back to the provider the
    // plan cannot create.
    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Linux" }));
    await screen.findByTestId("sandbox-create-not-creatable");

    expect(screen.getByTestId("sandbox-create-in-flight").textContent).toBe(
      "A sandbox is being created…",
    );

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
  });
});
