import {
  queryOptions,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { UNRESOLVED_PICK } from "@/lib/settings-environment-pages";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const scope = vi.hoisted(() => ({ failed: false, retry: vi.fn() }));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    WINDOW_HOST_SELECTION: {},
    useHostScopeFor: () =>
      hostScopeFixture({
        activeHostId: "window-host",
        host: null,
        listsFailed: scope.failed,
        retryLists: scope.retry,
      }),
  };
});

beforeEach(() => {
  scope.failed = false;
  scope.retry.mockClear();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
  });
});
afterEach(cleanup);

it.each(SETTINGS_SECTIONS.filter((section) => section.group === "personal"))(
  "holds $id without mounting its editors until a configuration is known",
  ({ id }) => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PersonalPageFrame section={id}>
          <button>Edit configuration</button>
        </PersonalPageFrame>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("environment-source-loading")).toBeTruthy();
    expect(screen.queryByText("Edit configuration")).toBeNull();
  },
);

it("shows the failed host list and retries it without mounting a Personal page", () => {
  scope.failed = true;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PersonalPageFrame section="skills">
        <button>Edit configuration</button>
      </PersonalPageFrame>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Couldn't load your hosts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(scope.retry).toHaveBeenCalledOnce();
  expect(screen.queryByText("Edit configuration")).toBeNull();
});

it("observes an errored status read and retries that host's query", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
    "window-host",
    "environment.status",
    {},
  );
  render(
    <QueryClientProvider client={queryClient}>
      <PersonalPageFrame section="providers">
        <button>Edit configuration</button>
      </PersonalPageFrame>
    </QueryClientProvider>,
  );
  await act(async () => {
    await queryClient
      .fetchQuery(
        queryOptions({
          queryKey,
          queryFn: () => Promise.reject(new Error("unavailable")),
        }),
      )
      .catch(() => undefined);
  });
  expect(screen.getByText("Couldn't read these settings.")).toBeTruthy();
  expect(screen.queryByTestId("environment-source-loading")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  expect(screen.queryByText("Edit configuration")).toBeNull();
});
