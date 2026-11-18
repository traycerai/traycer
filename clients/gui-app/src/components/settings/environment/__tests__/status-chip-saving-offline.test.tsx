import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
  useMutation,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useConfigurationSavingOffline } from "@/components/settings/environment/status-chip-mutations";

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false, gcTime: Infinity } },
  });
  onlineManager.setOnline(false);
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

/** Queues a write while offline, the way a settings page does. */
function QueuedWrite(props: {
  readonly method: string;
  readonly variables: Record<string, unknown>;
  readonly hostId: string | null;
}): ReactNode {
  const mutation = useMutation({
    mutationKey: [props.method],
    mutationFn: (_variables: Record<string, unknown>) => Promise.resolve(null),
    onMutate: () => ({ hostId: props.hostId }),
  });
  return (
    <button type="button" onClick={() => mutation.mutate(props.variables)}>
      queue {props.method}
    </button>
  );
}

async function queue(
  method: string,
  variables: Record<string, unknown>,
  hostId: string | null,
): Promise<void> {
  render(
    <QueuedWrite method={method} variables={variables} hostId={hostId} />,
    {
      wrapper: Wrapper,
    },
  );
  await userEvent.click(
    screen.getByRole("button", { name: `queue ${method}` }),
  );
  await waitFor(() => {
    expect(queryClient.getMutationCache().getAll().at(-1)?.state.isPaused).toBe(
      true,
    );
  });
}

function savingOffline(
  environmentId: string | null,
  hostIds: readonly string[],
): boolean {
  return renderHook(
    () => useConfigurationSavingOffline(environmentId, new Set(hostIds)),
    { wrapper: Wrapper },
  ).result.current;
}

describe("Saving when back online", () => {
  it("covers a paused skill edit on its own configuration only", async () => {
    await queue("providers.skillsMutate", { environmentId: "env-a" }, null);

    expect(savingOffline("env-a", [])).toBe(true);
    expect(savingOffline("env-b", [])).toBe(false);
    expect(savingOffline(null, [])).toBe(false);
  });

  it("covers a paused host-source write by the host it captured", async () => {
    await queue("providers.skillsMutate", {}, "host-a");

    expect(savingOffline(null, ["host-a"])).toBe(true);
    expect(savingOffline(null, ["host-b"])).toBe(false);
  });

  it("ignores a paused secret write and a write that is not a setting", async () => {
    await queue(
      "environment.secrets.destroy",
      { environmentId: "env-a" },
      "host-a",
    );
    await queue("epic.create", { environmentId: "env-a" }, "host-a");

    expect(savingOffline("env-a", ["host-a"])).toBe(false);
  });

  it("goes quiet once the connection returns and the write completes", async () => {
    await queue("providers.skillsMutate", { environmentId: "env-a" }, null);
    expect(savingOffline("env-a", [])).toBe(true);

    act(() => onlineManager.setOnline(true));

    await waitFor(() => {
      expect(savingOffline("env-a", [])).toBe(false);
    });
  });
});
