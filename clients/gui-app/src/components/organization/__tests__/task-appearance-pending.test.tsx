import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import { TaskAppearancePicker } from "@/components/organization/task-appearance-picker";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { TAB_COLORS } from "@/stores/tabs/tab-groups";

/**
 * The real provider with the real picker: what the picker shows and what the
 * tab strip draws while an appearance command is in flight, and how many
 * commands one burst of edits sends.
 */
interface SentCommand {
  readonly commandId: string;
  readonly action: OrganizationAction;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const state = vi.hoisted(() => {
  const identity = { hostId: "host-1", userId: "user-1" };
  const client = {
    getActiveHostId: () => identity.hostId,
    getRequestContextUserId: () => identity.userId,
  };
  const sent: SentCommand[] = [];
  const mutateAsync = (variables: {
    readonly command: {
      readonly commandId: string;
      readonly action: OrganizationAction;
    };
  }): Promise<unknown> =>
    new Promise((resolve, reject) => {
      sent.push({
        commandId: variables.command.commandId,
        action: variables.command.action,
        resolve: () =>
          resolve({
            commandId: variables.command.commandId,
            disposition: "durably-accepted",
          }),
        reject,
      });
    });
  const view: { current: OrganizationView | null } = { current: null };
  return { client, identity, sent, mutateAsync, view };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
  useAuthService: () => ({
    revalidateCurrentContextAfterInvalidation: () => Promise.resolve(null),
  }),
}));

vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierHostClient: <T,>(client: T): T => client,
  usePoolTierStreamClient: <T,>(client: T): T => client,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: state.identity.hostId,
    requestContextUserId: state.identity.userId,
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));

vi.mock("@/stores/auth/auth-store", () => {
  const snapshot = {
    status: "signed-in",
    contextMetadata: { userId: "user-1" },
  };
  return {
    authorizesCloudCapability: () => true,
    useAuthStore: Object.assign(
      <T,>(selector: (auth: typeof snapshot) => T): T => selector(snapshot),
      { getState: () => snapshot, subscribe: () => () => {} },
    ),
  };
});

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: state.view.current }),
  useHostMutation: () => ({ mutateAsync: state.mutateAsync }),
}));

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (load) => {
  const actual = await load<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

const [, BLUE, RED, YELLOW] = TAB_COLORS;

function viewWith(
  appearance: Partial<OrganizationView["appearances"][number]>,
): OrganizationView {
  return {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [
      {
        taskId: "task-1",
        version: "3",
        color: null,
        icon: null,
        ...appearance,
      },
    ],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}

function openTask(taskId: string): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab(taskId, taskId);
  const refs = useEpicCanvasStore.getState().openTabOrder.map((id) => ({
    kind: "epic" as const,
    id,
  }));
  useTabsStore.setState({
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: tabItemId(ref),
      ref,
    })),
    stripOrder: refs,
    activeItemId: refs.length > 0 ? tabItemId(refs[refs.length - 1]) : null,
    systemTabs: { history: null, settings: null },
  });
  return tabId;
}

let queryClient: QueryClient;
let tabId: string;

function tabColor(): string | null | undefined {
  return useTabsStore.getState().customizations?.[`epic:${tabId}`]?.color;
}

function tree(showPicker: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>
        {showPicker ? <TaskAppearancePicker taskId="task-1" /> : null}
      </OrganizationProvider>
    </QueryClientProvider>
  );
}

function swatch(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function pressed(name: string): boolean {
  return swatch(name).getAttribute("aria-pressed") === "true";
}

function appearanceAction(color: string | null): OrganizationAction {
  return { kind: "appearance", taskId: "task-1", color };
}

async function flush(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  state.sent.length = 0;
  state.identity.hostId = "host-1";
  state.identity.userId = "user-1";
  state.view.current = viewWith({});
  tabId = openTask("task-1");
});

afterEach(() => {
  cleanup();
});

describe("task appearance edits in flight", () => {
  it("paints a clicked swatch at once and sends one command", async () => {
    render(tree(true));
    await flush();

    fireEvent.click(swatch(BLUE.name));

    expect(pressed(BLUE.name)).toBe(true);
    expect(tabColor()).toBe(BLUE.value);
    await flush();
    expect(state.sent.map((sent) => sent.action)).toEqual([
      appearanceAction(BLUE.value),
    ]);
  });

  it("keeps one command in flight and sends only the latest pick after it", async () => {
    render(tree(true));
    await flush();

    fireEvent.click(swatch(BLUE.name));
    fireEvent.click(swatch(RED.name));
    fireEvent.click(swatch(YELLOW.name));
    await flush();

    expect(state.sent.map((sent) => sent.action)).toEqual([
      appearanceAction(BLUE.value),
    ]);
    expect(pressed(YELLOW.name)).toBe(true);

    act(() => state.sent[0].resolve());
    await flush();

    await waitFor(() => expect(state.sent).toHaveLength(2));
    await flush();
    expect(state.sent.map((sent) => sent.action)).toEqual([
      appearanceAction(BLUE.value),
      appearanceAction(YELLOW.value),
    ]);
  });

  it("rolls a refused edit back to the host's appearance", async () => {
    render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    expect(pressed(BLUE.name)).toBe(true);
    await flush();

    act(() => state.sent[0].reject(new Error("refused")));
    await flush();

    await waitFor(() => expect(pressed("Default")).toBe(true));
    expect(tabColor()).toBeNull();
  });

  it("drops an accepted edit the host later reports as failed", async () => {
    const ui = render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    expect(pressed(BLUE.name)).toBe(true);
    await flush();

    const { commandId } = state.sent[0];
    act(() => state.sent[0].resolve());
    await flush();

    state.view.current = {
      ...viewWith({}),
      failures: [
        {
          commandIds: [commandId],
          scope: "appearance:task-1",
          reason: "forbidden",
          message: "Task organization access denied",
        },
      ],
    };
    ui.rerender(tree(true));
    await flush();

    expect(pressed("Default")).toBe(true);
    expect(tabColor()).toBeNull();
  });

  it("keeps a confirmed pick through its own snapshot and yields to a later change from elsewhere", async () => {
    const ui = render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    await flush();
    act(() => state.sent[0].resolve());
    await flush();
    expect(pressed(BLUE.name)).toBe(true);

    state.view.current = viewWith({ version: "4", color: BLUE.value });
    ui.rerender(tree(true));
    await flush();
    expect(pressed(BLUE.name)).toBe(true);

    state.view.current = viewWith({ version: "5", color: RED.value });
    ui.rerender(tree(true));
    await flush();
    expect(pressed(RED.name)).toBe(true);
    expect(tabColor()).toBe(RED.value);
  });

  it("saves a custom color once, when the native control commits it", async () => {
    render(tree(true));
    await flush();
    const input = screen.getByLabelText("Custom tab color");

    fireEvent.input(input, { target: { value: "#112233" } });
    fireEvent.input(input, { target: { value: "#223344" } });
    fireEvent.input(input, { target: { value: "#334455" } });
    await flush();
    expect(state.sent).toHaveLength(0);

    fireEvent(input, new Event("change", { bubbles: true }));

    await waitFor(() => expect(state.sent).toHaveLength(1));
    await flush();
    expect(state.sent.map((sent) => sent.action)).toEqual([
      appearanceAction("#334455"),
    ]);
  });

  it("saves an unsaved custom drag when the picker closes", async () => {
    const ui = render(tree(true));
    await flush();

    fireEvent.input(screen.getByLabelText("Custom tab color"), {
      target: { value: "#112233" },
    });
    await flush();
    expect(state.sent).toHaveLength(0);

    ui.rerender(tree(false));

    await waitFor(() => expect(state.sent).toHaveLength(1));
    await flush();
    expect(state.sent.map((sent) => sent.action)).toEqual([
      appearanceAction("#112233"),
    ]);
  });

  it("never overlaps an icon save with a color edit", async () => {
    render(tree(true));
    await flush();
    const icon = screen.getByLabelText("Icon");
    fireEvent.change(icon, { target: { value: "API" } });
    fireEvent.blur(icon);
    await waitFor(() => expect(state.sent).toHaveLength(1));
    expect(state.sent[0].action).toEqual({
      kind: "appearance",
      taskId: "task-1",
      icon: "API",
    });

    fireEvent.click(swatch(BLUE.name));
    await flush();
    expect(state.sent).toHaveLength(1);

    act(() => state.sent[0].resolve());
    await flush();

    await waitFor(() => expect(state.sent).toHaveLength(2));
    await flush();
    expect(state.sent[1].action).toEqual(appearanceAction(BLUE.value));
  });

  it("clears an unsaved custom preview when Reset runs", async () => {
    state.view.current = viewWith({ color: BLUE.value });
    const ui = render(tree(true));
    await flush();

    fireEvent.input(screen.getByLabelText("Custom tab color"), {
      target: { value: "#112233" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await flush();
    act(() => state.sent[0].resolve());
    await flush();

    expect(pressed("Default")).toBe(true);

    ui.rerender(tree(false));
    await flush();
    expect(state.sent.map((sent) => sent.action)).toEqual([
      { kind: "appearance", taskId: "task-1", color: null, icon: null },
    ]);
  });

  it("rolls back only the refused edit while a later one is queued", async () => {
    render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    await flush();
    const icon = screen.getByLabelText("Icon");
    fireEvent.change(icon, { target: { value: "API" } });
    fireEvent.blur(icon);
    await flush();
    expect(state.sent).toHaveLength(1);

    act(() => state.sent[0].reject(new Error("refused")));
    await flush();

    expect(pressed("Default")).toBe(true);
    await waitFor(() => expect(state.sent).toHaveLength(2));
    expect(state.sent[1].action).toEqual({
      kind: "appearance",
      taskId: "task-1",
      icon: "API",
    });
  });

  it("keeps an acknowledged edit when a later queued edit is refused", async () => {
    render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    await flush();
    const icon = screen.getByLabelText("Icon");
    fireEvent.change(icon, { target: { value: "API" } });
    fireEvent.blur(icon);
    await flush();

    act(() => state.sent[0].resolve());
    await flush();
    await waitFor(() => expect(state.sent).toHaveLength(2));
    act(() => state.sent[1].reject(new Error("refused")));
    await flush();

    expect(pressed(BLUE.name)).toBe(true);
    expect(tabColor()).toBe(BLUE.value);
  });

  it("does not adopt an unrelated later version as the edit's baseline", async () => {
    const ui = render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    await flush();

    state.view.current = viewWith({ version: "4", color: BLUE.value });
    ui.rerender(tree(true));
    await flush();
    state.view.current = viewWith({ version: "5", color: RED.value });
    ui.rerender(tree(true));
    await flush();

    act(() => state.sent[0].resolve());
    await flush();

    expect(pressed(RED.name)).toBe(true);
    expect(tabColor()).toBe(RED.value);
  });

  it("ignores a stale completion after the host or account changes and changes back", async () => {
    const ui = render(tree(true));
    await flush();
    fireEvent.click(swatch(BLUE.name));
    await flush();

    state.identity.hostId = "host-2";
    ui.rerender(tree(true));
    await flush();
    state.identity.hostId = "host-1";
    ui.rerender(tree(true));
    await flush();

    fireEvent.click(swatch(RED.name));
    await flush();
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1].action).toEqual(appearanceAction(RED.value));

    act(() => state.sent[0].reject(new Error("refused")));
    await flush();

    expect(pressed(RED.name)).toBe(true);
  });
});
