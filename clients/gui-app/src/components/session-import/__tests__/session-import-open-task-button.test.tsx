import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  hostId: "stream-host",
  request: vi.fn(),
  resolvedHostIds: [] as string[],
  navigate: vi.fn(),
  intents: [] as Array<Record<string, unknown>>,
  rejectActivation: false,
  toast: vi.fn(),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: harness.hostId,
    requestContextUserId: "user-1",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({ hostId: "ambient-host", hostClient: {} }),
}));

vi.mock("@/lib/host/binding-host-client", () => ({
  resolveNamedHostClient: (_binding: unknown, hostId: string) => {
    harness.resolvedHostIds.push(hostId);
    return { request: harness.request };
  },
}));

vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamHostId: () => harness.hostId,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => harness.navigate,
}));

vi.mock("@/lib/tab-navigation", () => ({
  activateTabIntent: (
    navigate: (options: Record<string, unknown>) => Promise<void>,
    intent: Record<string, unknown>,
    options: { onRejected?: (error: Error) => void } | undefined,
  ) => {
    harness.intents.push(intent);
    if (harness.rejectActivation) {
      options?.onRejected?.(
        new Error("Another task was opened before this task could open."),
      );
      return true;
    }
    void navigate({}).catch(() => undefined);
    return true;
  },
  resourceEpicTabIntent: (intent: Record<string, unknown>) => intent,
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostErrorWithDetail: harness.toast,
}));

import { SessionImportOpenTaskButton } from "@/components/session-import/session-import-open-task-button";

function renderButton(
  onTaskOpened: () => void,
  onBeforeTaskOpen: (() => Promise<boolean>) | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionImportOpenTaskButton
        target={{
          kind: "already_in_traycer",
          epicId: "epic-1",
          chatId: "chat-1",
        }}
        title="Imported task"
        onTaskOpened={onTaskOpened}
        onBeforeTaskOpen={onBeforeTaskOpen}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  harness.hostId = "stream-host";
  harness.request.mockReset();
  harness.resolvedHostIds.length = 0;
  harness.navigate.mockReset();
  harness.navigate.mockResolvedValue(undefined);
  harness.intents.length = 0;
  harness.rejectActivation = false;
  harness.toast.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SessionImportOpenTaskButton", () => {
  it("rechecks and opens the imported task through the stream host", async () => {
    harness.request.mockResolvedValue({ settings: { model: "model-1" } });
    const onTaskOpened = vi.fn();
    renderButton(onTaskOpened, null);

    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Imported task" }),
    );

    await waitFor(() => expect(onTaskOpened).toHaveBeenCalledTimes(1));
    expect(harness.resolvedHostIds).toEqual(["stream-host"]);
    expect(harness.request).toHaveBeenCalledWith("epic.getChatRunSettings", {
      epicId: "epic-1",
      chatId: "chat-1",
    });
    expect(harness.intents[0]).toMatchObject({
      preparation: {
        node: { type: "chat", id: "chat-1", hostId: "stream-host" },
      },
    });
  });

  it("keeps the wizard open and reports an unavailable task when settings are missing", async () => {
    harness.request.mockResolvedValue({ settings: null });
    const onTaskOpened = vi.fn();
    renderButton(onTaskOpened, null);

    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Imported task" }),
    );

    await waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    expect(onTaskOpened).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Open task: Imported task" }),
    ).toBeTruthy();
  });

  it("keeps the wizard open when navigation fails", async () => {
    harness.request.mockResolvedValue({ settings: { model: "model-1" } });
    harness.navigate.mockRejectedValue(new Error("navigation failed"));
    const onTaskOpened = vi.fn();
    renderButton(onTaskOpened, null);

    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Imported task" }),
    );

    await waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    expect(onTaskOpened).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Open task: Imported task" }),
    ).toBeTruthy();
  });

  it("reports an activation rejection, clears pending state, and allows retry", async () => {
    harness.request.mockResolvedValue({ settings: { model: "model-1" } });
    harness.rejectActivation = true;
    const onTaskOpened = vi.fn();
    renderButton(onTaskOpened, null);
    const button = () =>
      screen.getByRole("button", { name: "Open task: Imported task" });

    fireEvent.click(button());

    await waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    expect(onTaskOpened).not.toHaveBeenCalled();
    expect(button()).toHaveProperty("disabled", false);
    expect(harness.navigate).not.toHaveBeenCalled();

    harness.rejectActivation = false;
    fireEvent.click(button());

    await waitFor(() => expect(onTaskOpened).toHaveBeenCalledTimes(1));
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it("does not navigate when the caller cannot finish its pre-open work", async () => {
    harness.request.mockResolvedValue({ settings: { model: "model-1" } });
    const onTaskOpened = vi.fn();
    const onBeforeTaskOpen = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    renderButton(onTaskOpened, onBeforeTaskOpen);

    fireEvent.click(
      screen.getByRole("button", { name: "Open task: Imported task" }),
    );

    await waitFor(() => expect(onBeforeTaskOpen).toHaveBeenCalledTimes(1));
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.intents).toHaveLength(0);
    expect(onTaskOpened).not.toHaveBeenCalled();
  });
});
