import { type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentConfigurationItem,
  EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import { TeamTextItems } from "@/components/settings/environment/team-text-items";
import { useConfigurationItemWrites } from "@/components/settings/environment/configuration-item-writes";
import { useConfigurationVariablesQuery } from "@/hooks/environment/team/use-variables-query";
import { READ_BOUND_MS } from "@/hooks/environment/team/use-bounded-read";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  vi.useRealTimers();
});

function TextItemsPage(): ReactNode {
  const query = useConfigurationVariablesQuery();
  const writes = useConfigurationItemWrites(query, () => undefined);
  return (
    <TeamTextItems
      items={query.data ?? []}
      kind="variable"
      os="any"
      providerId={null}
      writes={writes}
      renderDetails={() => null}
    />
  );
}

const variable = (
  value: string,
  revision: number,
): EnvironmentConfigurationItem =>
  configurationItem({
    kind: "variable",
    key: "NODE_ENV",
    os: "any",
    value: { value },
    revision,
  });
const shell = configurationItem({
  kind: "shell",
  key: "shell",
  os: "any",
  value: { path: "/bin/zsh", args: [] },
});

async function editVariable(value: string): Promise<void> {
  await userEvent.click(
    await screen.findByRole("textbox", { name: "NODE_ENV value" }),
  );
  const field = screen.getByLabelText("NODE_ENV value");
  await userEvent.clear(field);
  await userEvent.type(field, value);
}

async function expectRecovered(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByRole("textbox", { name: "Variable name" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByRole("status")).toBeNull();
  });
}

describe("TeamTextItems accepted writes", () => {
  it("keeps an added variable pending despite a shell with its name, then confirms the variable revision", async () => {
    let items = [shell];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 2,
      }),
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await userEvent.click(
      screen.getByRole("textbox", { name: "Variable name" }),
    );
    await userEvent.type(screen.getByLabelText("Variable name"), "shell");
    await userEvent.type(
      screen.getByLabelText("New variable value"),
      "custom-shell",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    expect(
      await screen.findByText("Saved, but latest settings haven't refreshed."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Variable name")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("custom-shell")).toBeTruthy();
    items = [
      shell,
      configurationItem({
        kind: "variable",
        key: "shell",
        os: "any",
        value: { value: "custom-shell" },
        revision: 2,
      }),
    ];
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expectRecovered();
    await userEvent.click(screen.getByRole("textbox", { name: "shell value" }));
    expect(screen.getByLabelText("shell value")).toHaveProperty(
      "value",
      "custom-shell",
    );
  });

  it("moves a refused new-variable draft when its name changes before a deliberate Save", async () => {
    let items: EnvironmentConfigurationItem[] = [];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) throw new Error("write unavailable");
        items = [
          configurationItem({
            kind: "variable",
            key: "NEW_NAME",
            os: "any",
            value: { value: "draft" },
            revision: 2,
          }),
        ];
        return { outcome: "saved", revision: 2 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await userEvent.click(
      screen.getByRole("textbox", { name: "Variable name" }),
    );
    await userEvent.type(screen.getByLabelText("Variable name"), "OLD_NAME");
    await userEvent.type(screen.getByLabelText("New variable value"), "draft");
    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    await screen.findByRole("alert");
    await userEvent.clear(screen.getByLabelText("Variable name"));
    await userEvent.type(screen.getByLabelText("Variable name"), "NEW_NAME");
    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    await expectRecovered();
    expect(screen.getByLabelText("Variable name")).toHaveProperty("value", "");
    expect(
      screen.getByRole("textbox", { name: "NEW_NAME value" }),
    ).toHaveProperty("value", "draft");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([
      { key: "OLD_NAME", revision: null },
      { key: "NEW_NAME", revision: null },
    ]);
  });

  it("retains a disappearing delete until acceptance and a successful absent read, despite a shell collision", async () => {
    const text = configurationItem({
      kind: "variable",
      key: "shell",
      os: "any",
      value: { value: "custom-shell" },
    });
    let items = [shell, text];
    const deletion =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.delete": () => deletion.promise,
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await userEvent.click(
      within(await screen.findByRole("region", { name: "shell" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    items = [shell];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    expect(
      within(screen.getByRole("region", { name: "shell" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("shell · Removing");
    await act(async () => {
      deletion.resolve({ outcome: "saved", revision: 2 });
      await deletion.promise;
    });
    await expectRecovered();
    expect(screen.queryByRole("region", { name: "shell" })).toBeNull();
    await userEvent.click(
      screen.getByRole("textbox", { name: "Variable name" }),
    );
    expect(screen.getByLabelText("Variable name")).toBeTruthy();
  });

  it("adopts a superseding different row across an in-flight editor remount and quotes its revision next", async () => {
    let items = [variable("development", 1)];
    const write =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        return puts === 1 ? write.promise : { outcome: "forbidden" };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("production");
    await userEvent.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );
    items = [variable("staging", 3)];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("NODE_ENV value")).toHaveProperty(
        "value",
        "production",
      );
      expect(screen.getByLabelText("NODE_ENV value")).toHaveProperty(
        "disabled",
        true,
      );
    });
    await act(async () => {
      write.resolve({ outcome: "saved", revision: 2 });
      await write.promise;
    });
    expect(
      await screen.findByText("Saved. These settings changed again."),
    ).toBeTruthy();
    await editVariable("next-value");
    await userEvent.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(2);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 3, value: { value: "next-value" } });
    expect(screen.getByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "next-value",
    );
  });

  it("adopts a recreated variable newer than an accepted delete receipt", async () => {
    let items = [variable("original", 1)];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.delete": () => {
        items = [variable("recreated", 3)];
        return { outcome: "saved", revision: 2 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await userEvent.click(
      within(await screen.findByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    expect(
      await screen.findByText("Removed. These settings changed again."),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("textbox", { name: "NODE_ENV value" }),
    );
    expect(screen.getByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "recreated",
    );
    expect(
      harness.paramsOf("environment.configuration.items.delete"),
    ).toHaveLength(1);
  });

  it("keeps a draft and its transport failure across an in-flight revision change, then saves on the new revision", async () => {
    let puts = 0;
    const firstWrite =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const linux = { ...variable("linux-value", 1), os: "linux" as const };
    let items = [variable("development", 1), linux];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) return firstWrite.promise;
        items = [variable("production", 3), linux];
        return { outcome: "saved", revision: 3 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("production");
    await userEvent.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );
    const submittedField = screen.getByLabelText("NODE_ENV value");
    items = [variable("server-value", 2), linux];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    await waitFor(() => {
      const field = screen.getByLabelText("NODE_ENV value");
      expect(field).not.toBe(submittedField);
      expect(field).toHaveProperty("value", "production");
      expect(field).toHaveProperty("disabled", true);
    });
    await act(async () => {
      firstWrite.reject(new Error("the cloud could not be reached"));
      await firstWrite.promise.catch(() => undefined);
    });
    const row = screen.getByRole("region", { name: "NODE_ENV" });
    expect(await within(row).findByRole("alert")).toHaveProperty(
      "textContent",
      "the cloud could not be reached",
    );
    expect(
      within(
        screen.getByRole("region", { name: "NODE_ENV · Linux" }),
      ).queryByRole("alert"),
    ).toBeNull();
    expect(within(row).getByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "production",
    );
    expect(within(row).getByLabelText("NODE_ENV value")).toHaveProperty(
      "disabled",
      false,
    );
    expect(within(row).getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByText(/Saved[.,]/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await expectRecovered();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "NODE_ENV value" }),
    ).toHaveProperty("value", "production");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(2);
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 2 });
  });

  it("retains acceptance after a failed read and retries only that read before unlocking", async () => {
    let failing = false;
    let items = [variable("development", 1)];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => {
        if (failing) throw new Error("read unavailable");
        return { items };
      },
      "environment.configuration.items.put": () => {
        failing = true;
        return { outcome: "saved", revision: 2 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("production");
    await userEvent.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );
    expect(
      await screen.findByText("Saved, but latest settings haven't refreshed."),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "NODE_ENV value" }),
    ).toHaveProperty("value", "production");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const reads = harness.paramsOf("environment.configuration.items").length;
    failing = false;
    items = [variable("production", 2)];
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expectRecovered();
    expect(harness.paramsOf("environment.configuration.items")).toHaveLength(
      reads + 1,
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    await editVariable("third-value");
    expect(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    ).toHaveProperty("disabled", false);
  });

  it("bounds a hanging accepted read and recovers through Retry without another mutation", async () => {
    let items = [variable("development", 1)];
    let hanging = false;
    const stalled = Promise.withResolvers<{
      items: EnvironmentConfigurationItem[];
    }>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () =>
        hanging ? stalled.promise : { items },
      "environment.configuration.items.put": () => {
        hanging = true;
        return { outcome: "saved", revision: 2 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("production");
    vi.useFakeTimers();
    act(() => {
      fireEvent.click(
        within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
          "button",
          { name: "Save" },
        ),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Saved. Checking latest settings…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS);
    });
    expect(
      screen.getByText("Saved, but latest settings haven't refreshed."),
    ).toBeTruthy();
    hanging = false;
    items = [variable("production", 2)];
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
    await expectRecovered();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    await editVariable("recovered");
    await act(async () => {
      stalled.resolve({ items: [variable("development", 1)] });
      await stalled.promise;
    });
    expect(screen.getByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "recovered",
    );
  });
});

describe("TeamTextItems focus", () => {
  it("shows saved and new-variable fields with their actions before an Edit or Add step", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [variable("a", 1)] }),
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    expect(await screen.findByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "a",
    );
    expect(screen.getByLabelText("Variable name")).toBeTruthy();
    expect(screen.getByLabelText("New variable value")).toBeTruthy();
    const saved = screen.getByRole("region", { name: "NODE_ENV" });
    expect(within(saved).getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(saved).getByRole("button", { name: "Delete" }),
    ).toHaveProperty("disabled", false);
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.queryByRole("button", {
        name: /^Edit |^More for |^Add variable$/,
      }),
    ).toBeNull();
  });

  it("puts focus on the value input when an existing variable is edited", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [variable("a", 1)] }),
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await userEvent.click(
      await screen.findByRole("textbox", { name: "NODE_ENV value" }),
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("NODE_ENV value"),
    );
  });
});
