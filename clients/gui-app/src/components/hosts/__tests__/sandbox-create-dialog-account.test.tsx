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
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";

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
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));
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

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
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
      },
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
      ],
    },
  ],
};

function signInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
  });
}

function openDialog(): void {
  act(() => {
    useSandboxCreateDialogStore.getState().openDialog();
  });
}

async function closeDialog(): Promise<void> {
  act(() => {
    useSandboxCreateDialogStore.getState().closeDialog();
  });
  await waitFor(() => {
    expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
  });
}

function submit(): HTMLElement {
  return screen.getByTestId("sandbox-create-submit");
}

/** Account A has a create in flight that never answers; its dialog is closed. */
async function startNeverEndingCreateAsAccountA(): Promise<void> {
  mocks.binding?.auth.createSandbox.mockImplementation(
    () => new Promise<SandboxCreateFetchResult>(() => undefined),
  );
  signInAs("user-a");
  openDialog();
  await screen.findByTestId("sandbox-create-dialog");
  fireEvent.change(screen.getByTestId("sandbox-create-name"), {
    target: { value: "build-box" },
  });
  fireEvent.click(submit());
  await waitFor(() => {
    expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
  });
  await closeDialog();
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.catalogue = {
    isPending: false,
    isError: false,
    data: CATALOGUE,
    error: null,
    refetch: () => Promise.resolve(),
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <SandboxCreateDialog />
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  act(() => {
    useSandboxCreateDialogStore.getState().closeDialog();
  });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("<SandboxCreateDialog /> across accounts", () => {
  it("does not hold the dialog of account B for a create account A has in flight", async () => {
    await startNeverEndingCreateAsAccountA();

    signInAs("user-b");
    openDialog();
    await screen.findByTestId("sandbox-create-dialog");
    fireEvent.change(screen.getByTestId("sandbox-create-name"), {
      target: { value: "second-box" },
    });

    expect(screen.queryByTestId("sandbox-create-in-flight")).toBeNull();
    expect(submit().hasAttribute("disabled")).toBe(false);
  });

  it("control: the same account's reopened dialog is still held by its create", async () => {
    await startNeverEndingCreateAsAccountA();

    openDialog();
    await screen.findByTestId("sandbox-create-in-flight");
    fireEvent.change(screen.getByTestId("sandbox-create-name"), {
      target: { value: "second-box" },
    });

    expect(submit().hasAttribute("disabled")).toBe(true);
    expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
  });
});
