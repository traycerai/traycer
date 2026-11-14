import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentCloud,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { CloudNotificationHook } from "@traycer-clients/shared/environment/notification-hook-values";
import { NOTIFICATION_HOOKS_ITEM } from "@traycer-clients/shared/environment/notification-hook-item-kind";
import { grantedEnvironmentRole } from "@traycer/protocol/host/environment/contracts";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { TeamNotificationHooksSettingsPanel } from "@/components/settings/environment/team-notification-hooks-settings-panel";

const fixtures = vi.hoisted(() => ({
  hooks: [] as CloudNotificationHook[],
  requests: [] as EnvironmentTransportRequest[],
  status: 204,
  body: null as unknown,
}));

vi.mock("@/hooks/environment/team/use-configuration-items-query", () => ({
  useConfigurationItemsQuery: () => ({
    data: { hooks: fixtures.hooks, revision: 7 },
    error: null,
    isFetching: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/environment/use-environment-cloud", () => ({
  useEnvironmentCloud: () => (): EnvironmentCloud => ({
    authnBaseUrl: "https://authn.example/",
    bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
    transport: async (request) => {
      fixtures.requests.push(request);
      return {
        status: fixtures.status,
        text: fixtures.status === 204 ? "" : JSON.stringify(fixtures.body),
      };
    },
    onOriginSignIn: () => true,
  }),
}));

vi.mock("@/components/settings/environment/team-pick-label", () => ({
  useConfigurationName: () => "Acme",
}));

vi.mock(
  "@/stores/settings/settings-environment-pick-store",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/stores/settings/settings-environment-pick-store")
    >()),
    useEnvironmentPick: () => ({ kind: "team", environmentId: "team-1" }),
  }),
);

const buildHook: CloudNotificationHook = {
  id: "build-alerts",
  name: "Build alerts",
  enabled: true,
  severities: null,
  action: {
    type: "http",
    url: "https://hooks.example/builds",
    headers: { authorization: "Bearer literal-value" },
  },
};

afterEach(() => {
  cleanup();
  fixtures.hooks = [];
  fixtures.requests = [];
  fixtures.status = 204;
  fixtures.body = null;
});

function source(
  role: "admin" | "editor" | "viewer" | "unknown",
): ConfigurationSource {
  const effectiveRole =
    role === "admin"
      ? "admin"
      : role === "editor"
        ? "editor"
        : role === "viewer"
          ? grantedEnvironmentRole("viewer")
          : grantedEnvironmentRole("future-role");
  return {
    kind: "pool",
    configuration: "team",
    environmentId: "team-1",
    roomId: "room-1",
    providerHandle: "handle-1",
    effectiveRole,
  };
}

function renderPage(role: "admin" | "editor" | "viewer" | "unknown") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ConfigurationSourceContext.Provider value={source(role)}>
        {props.children}
      </ConfigurationSourceContext.Provider>
    </QueryClientProvider>
  );
  return render(<TeamNotificationHooksSettingsPanel />, { wrapper: Wrapper });
}

function requestBody(index = 0): Record<string, unknown> {
  const body = fixtures.requests[index]?.body;
  if (typeof body !== "object" || body === null)
    throw new Error("notification hooks PUT had no body");
  return body as Record<string, unknown>;
}

describe("team Notification hooks page", () => {
  it("shows the team's hooks and the C26 visibility copy", () => {
    fixtures.hooks = [buildHook];
    renderPage("editor");

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    expect(within(manager).getByText("Build alerts")).toBeTruthy();
    expect(
      within(manager).getByText("https://hooks.example/builds"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Each hook is sent from every computer of Acme. A member's own hooks aren't sent from there.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Everyone in Acme can see each hook's address and headers.",
      ),
    ).toBeTruthy();
  });

  it("shows the C26 empty-list words and Add hook", () => {
    fixtures.hooks = [];
    renderPage("editor");

    expect(
      screen.getAllByRole("button", { name: "Add hook" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("No notification hooks")).toBeTruthy();
    expect(
      screen.getByText(
        "Hooks send an HTTP request for enabled notification severities.",
      ),
    ).toBeTruthy();
  });

  it("adds an HTTP hook through the page and writes the current item revision", async () => {
    fixtures.hooks = [buildHook];
    renderPage("admin");

    fireEvent.click(screen.getAllByRole("button", { name: "Add hook" })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Release alerts" },
    });
    fireEvent.change(within(dialog).getByLabelText("URL"), {
      target: { value: "https://hooks.example/releases" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));

    await waitFor(() => expect(fixtures.requests).toHaveLength(1));
    expect(fixtures.requests[0]).toMatchObject({
      method: "PUT",
      url: "https://authn.example/api/v3/environments/team-1/items/notification_hooks",
    });
    expect(requestBody()).toMatchObject({
      key: NOTIFICATION_HOOKS_ITEM.key,
      os: null,
      revision: 7,
      upload: null,
    });
    const values = requestBody().value as Array<Record<string, unknown>>;
    expect(values.map(({ name }) => name)).toEqual([
      "Build alerts",
      "Release alerts",
    ]);
    expect(values.every((hook) => hook.held === false)).toBe(true);
  });

  it("edits the selected team hook and keeps the other hooks", async () => {
    fixtures.hooks = [
      buildHook,
      { ...buildHook, id: "deploy-alerts", name: "Deploy alerts" },
    ];
    renderPage("editor");

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    fireEvent.click(
      within(manager).getAllByRole("button", { name: "Edit" })[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Build alerts revised" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));

    await waitFor(() => expect(fixtures.requests).toHaveLength(1));
    const values = requestBody().value as Array<Record<string, unknown>>;
    expect(values.map(({ name }) => name)).toEqual([
      "Build alerts revised",
      "Deploy alerts",
    ]);
    expect(requestBody().revision).toBe(7);
  });

  it("deletes a team hook with the C26 team confirmation sentence", async () => {
    fixtures.hooks = [buildHook];
    renderPage("editor");

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    fireEvent.click(within(manager).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).getByText("Delete hook?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        '"Build alerts" will stop being sent from Acme\'s computers.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fixtures.requests).toHaveLength(1));
    expect(requestBody()).toMatchObject({
      key: NOTIFICATION_HOOKS_ITEM.key,
      revision: 7,
      value: [],
    });
  });

  it("blocks an interpolating header with the C26 local-only sentence", async () => {
    fixtures.hooks = [];
    renderPage("editor");

    fireEvent.click(screen.getByRole("button", { name: "Add hook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Build alerts" },
    });
    fireEvent.change(within(dialog).getByLabelText("URL"), {
      target: { value: "https://hooks.example/builds" },
    });
    fireEvent.change(within(dialog).getByLabelText("Headers"), {
      target: { value: "authorization: Bearer $BUILD_TOKEN" },
    });

    expect(
      within(dialog).getByText(
        "A team's hook can't read $BUILD_TOKEN from a computer. Type the value itself.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Save hook" }),
    ).toHaveProperty("disabled", true);
    expect(fixtures.requests).toHaveLength(0);
  });

  it.each([
    "hook_id_duplicate",
    "hook_local_only",
    "hook_held_invalid",
  ] as const)("keeps the refusal %s safe in the team editor", async (code) => {
    fixtures.hooks = [buildHook];
    fixtures.status = 400;
    fixtures.body = {
      statusCode: 400,
      error: `refused ${buildHook.id} ${buildHook.action.url}`,
      code,
      index: 0,
    };
    renderPage("editor");

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    fireEvent.click(within(manager).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Build alerts updated" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save hook" }));

    await waitFor(() => expect(fixtures.requests).toHaveLength(1));
    if (code === "hook_local_only") {
      expect(
        within(dialog).getByText(
          "A team's hook can't read $NAME from a computer. Type the value itself.",
        ),
      ).toBeTruthy();
    }
    const errorText =
      code === "hook_local_only"
        ? (dialog.textContent ?? "")
        : (within(manager).getByRole("alert").textContent ?? "");
    expect(errorText).not.toContain(buildHook.id);
    expect(errorText).not.toContain(buildHook.action.url);
    expect(errorText).not.toContain(code);
  });

  it.each([
    ["admin", true],
    ["editor", true],
    ["viewer", false],
    ["unknown", false],
  ] as const)("gives %s the expected team hook controls", (role, canEdit) => {
    fixtures.hooks = [buildHook];
    renderPage(role);

    const manager = screen.getByTestId("cloud-notification-hooks-manager");
    expect(within(manager).getByText("Build alerts")).toBeTruthy();
    expect(
      within(manager).queryByRole("button", { name: "Add hook" }) !== null,
    ).toBe(canEdit);
    expect(
      within(manager).queryByRole("button", { name: "Edit" }) !== null,
    ).toBe(canEdit);
    expect(
      within(manager).queryByRole("button", { name: "Delete" }) !== null,
    ).toBe(canEdit);
    expect(
      within(manager).getByRole("switch", { name: "Build alerts enabled" }),
    ).toHaveProperty("disabled", !canEdit);
  });
});
