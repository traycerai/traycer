import { type ReactNode, useEffect } from "react";
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
import {
  useConfigurationItemWrites,
  type ConfigurationItemWrite,
  type ConfigurationItemWrites,
} from "@/components/settings/environment/configuration-item-writes";
import { useConfigurationProviderItemsQuery } from "@/hooks/environment/team/use-provider-items-query";
import { useConfigurationVariablesQuery } from "@/hooks/environment/team/use-variables-query";
import { READ_BOUND_MS } from "@/hooks/environment/team/use-bounded-read";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
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

function DetailedItemsPage(): ReactNode {
  const query = useConfigurationVariablesQuery();
  const writes = useConfigurationItemWrites(query, () => undefined);
  return (
    <TeamTextItems
      items={query.data ?? []}
      kind="variable"
      os="any"
      providerId={null}
      writes={writes}
      renderDetails={(item) => <span>{`Details ${item.key}`}</span>}
    />
  );
}

function ProviderEnvPage(): ReactNode {
  const query = useConfigurationProviderItemsQuery();
  const writes = useConfigurationItemWrites(query, () => undefined);
  return (
    <TeamTextItems
      items={query.data ?? []}
      kind="env_override"
      os="any"
      providerId="claude"
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

function nodeRegion(): HTMLElement {
  return screen.getByRole("region", { name: "NODE_ENV" });
}

function nodeValue(): HTMLElement {
  return within(nodeRegion()).getByRole("textbox", {
    name: "Value for NODE_ENV",
  });
}

async function editVariable(value: string): Promise<void> {
  const field = await within(
    await screen.findByRole("region", { name: "NODE_ENV" }),
  ).findByRole("textbox", { name: "Value for NODE_ENV" });
  await userEvent.clear(field);
  await userEvent.type(field, value);
}

function commitNodeValue(): void {
  fireEvent.blur(nodeValue());
}

async function openAdd(): Promise<void> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Add a variable" }),
  );
  await screen.findByRole("region", { name: "New variable" });
}

async function expectUnlocked(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByRole("status")).toBeNull();
  });
}

function mountEditor(
  items: () => { items: EnvironmentConfigurationItem[] },
  put: () => EnvironmentConfigurationItemWriteResponse,
): TeamPageHarness {
  return mountTeamPage(poolSource("editor"), {
    "environment.configuration.items": items,
    "environment.configuration.items.put": put,
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
    await openAdd();
    await userEvent.type(screen.getByLabelText("New variable name"), "shell");
    await userEvent.type(
      screen.getByLabelText("New variable value"),
      "custom-shell",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Apply variable" }),
    );
    expect(
      await screen.findByText("Saved, but latest settings haven't refreshed."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", true);
    const pending = screen.getByRole("region", { name: "shell" });
    expect(within(pending).getByText("custom-shell")).toBeTruthy();
    expect(within(pending).queryByRole("textbox")).toBeNull();
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
    await expectUnlocked();
    const saved = screen.getByRole("region", { name: "shell" });
    await userEvent.click(
      within(saved).getByRole("textbox", { name: "Value for shell" }),
    );
    expect(within(saved).getByLabelText("Value for shell")).toHaveProperty(
      "value",
      "custom-shell",
    );
  });

  it("moves a refused new-variable draft when its name changes before a deliberate Apply", async () => {
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
    await openAdd();
    await userEvent.type(
      screen.getByLabelText("New variable name"),
      "OLD_NAME",
    );
    await userEvent.type(screen.getByLabelText("New variable value"), "draft");
    await userEvent.click(
      screen.getByRole("button", { name: "Apply variable" }),
    );
    await screen.findByRole("alert");
    await userEvent.clear(screen.getByLabelText("New variable name"));
    await userEvent.type(
      screen.getByLabelText("New variable name"),
      "NEW_NAME",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Apply variable" }),
    );
    await expectUnlocked();
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Value for NEW_NAME" }),
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
        { name: "Remove shell" },
      ),
    );
    items = [shell];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    expect(
      within(screen.getByRole("region", { name: "shell" })).getByRole(
        "button",
        {
          name: "Remove shell",
        },
      ),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("shell · Removing");
    await act(async () => {
      deletion.resolve({ outcome: "saved", revision: 2 });
      await deletion.promise;
    });
    await expectUnlocked();
    expect(screen.queryByRole("region", { name: "shell" })).toBeNull();
    await openAdd();
    expect(screen.getByLabelText("New variable name")).toBeTruthy();
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
    commitNodeValue();
    items = [variable("staging", 3)];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    await waitFor(() => {
      const field = nodeValue();
      expect(field).toHaveProperty("value", "production");
      expect(field).toHaveProperty("disabled", true);
      expect(screen.getByRole("status").textContent).toBe("NODE_ENV · Saving");
    });
    await act(async () => {
      write.resolve({ outcome: "saved", revision: 2 });
      await write.promise;
    });
    expect(
      await screen.findByText("Saved. These settings changed again."),
    ).toBeTruthy();
    await editVariable("next-value");
    commitNodeValue();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(2);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 3, value: { value: "next-value" } });
    expect(nodeValue()).toHaveProperty("value", "next-value");
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
        { name: "Remove NODE_ENV" },
      ),
    );
    expect(
      await screen.findByText("Removed. These settings changed again."),
    ).toBeTruthy();
    await userEvent.click(nodeValue());
    expect(nodeValue()).toHaveProperty("value", "recreated");
    expect(
      harness.paramsOf("environment.configuration.items.delete"),
    ).toHaveLength(1);
  });

  it("keeps a draft and its transport failure across an in-flight revision change, then saves on the new revision", async () => {
    let puts = 0;
    const firstWrite =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const linux = configurationItem({
      kind: "variable",
      key: "NODE_ENV",
      os: "linux",
      value: { value: "linux-value" },
      revision: 1,
    });
    let items = [variable("development", 1), linux];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) return firstWrite.promise;
        if (puts === 2) {
          return {
            outcome: "conflict",
            current: { revision: 2, changedBy: "Teammate", changedAt: 2 },
          };
        }
        items = [variable("production", 3), linux];
        return { outcome: "saved", revision: 3 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("production");
    commitNodeValue();
    const submittedField = nodeValue();
    items = [variable("server-value", 2), linux];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    await waitFor(() => {
      const field = nodeValue();
      expect(field).not.toBe(submittedField);
      expect(field).toHaveProperty("value", "production");
      expect(field).toHaveProperty("disabled", true);
    });
    await act(async () => {
      firstWrite.reject(new Error("the cloud could not be reached"));
      await firstWrite.promise.catch(() => undefined);
    });
    const row = nodeRegion();
    expect(await within(row).findByRole("alert")).toHaveProperty(
      "textContent",
      "Cloud service is temporarily unavailable. Please try again shortly.",
    );
    expect(
      within(
        screen.getByRole("region", { name: "NODE_ENV · Linux" }),
      ).queryByRole("alert"),
    ).toBeNull();
    expect(within(row).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "production",
    );
    expect(within(row).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "disabled",
      false,
    );
    expect(
      within(row).getByRole("button", { name: "Remove NODE_ENV" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Saved[.,]/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    commitNodeValue();
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() => {
      expect(nodeValue()).toHaveProperty("disabled", false);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(2);
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 1 });
    commitNodeValue();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(3);
    });
    await expectUnlocked();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nodeValue()).toHaveProperty("value", "production");
    expect(
      harness.paramsOf("environment.configuration.items.put")[2],
    ).toMatchObject({ revision: 2 });
  });

  it("the hook's unmount writer skips a failed draft restored to its submitted text", async () => {
    const harness = mountEditor(
      () => ({ items: [variable("development", 1)] }),
      () => ({ outcome: "saved", revision: 2 }),
    );
    const observeWrites = vi.fn<(writes: ConfigurationItemWrites) => void>();
    function WritesProbe(): ReactNode {
      const query = useConfigurationVariablesQuery();
      const writes = useConfigurationItemWrites(query, () => undefined);
      useEffect(() => observeWrites(writes), [writes]);
      return <p>{query.data === undefined ? "loading" : query.data.length}</p>;
    }
    render(<WritesProbe />, { wrapper: harness.Wrapper });
    expect(await screen.findByText("1")).toBeTruthy();
    const getWrites = (): ConfigurationItemWrites => {
      const writes = observeWrites.mock.lastCall?.[0];
      if (writes === undefined)
        throw new Error("The item writes hook is absent.");
      return writes;
    };
    const submitted: ConfigurationItemWrite = {
      kind: "variable",
      key: "NODE_ENV",
      os: "any",
      action: "put",
      value: { value: "submitted" },
      original: variable("development", 1),
    };
    const beforeWrite = vi.mocked(globalThis.fetch).mock.calls.length;
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(
      new Error("The transport did not answer."),
    );
    const firstWrites = getWrites();
    await act(async () => {
      await firstWrites.write(submitted);
    });
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(
      beforeWrite + 1,
    );
    const failedWrites = getWrites();
    const failure = failedWrites.failure;
    if (failure === null) throw new Error("The failed draft was not retained.");
    expect(failure.write.value).toEqual(submitted.value);

    act(() => {
      failedWrites.updateDraft({
        ...submitted,
        value: { value: "submitted!" },
      });
    });
    const editedWrites = getWrites();
    act(() => {
      editedWrites.updateDraft(submitted);
    });
    const restoredWrites = getWrites();
    await act(async () => {
      await restoredWrites.writeOnUnmount(submitted);
    });

    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(
      beforeWrite + 1,
    );
  });

  it("the hook's unmount writer uses the last-typed revision after refusal (model via public calls)", async () => {
    let items = [variable("shown", 3)];
    let puts = 0;
    const firstWrite =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        return puts === 1
          ? firstWrite.promise
          : {
              outcome: "conflict",
              current: { revision: 4, changedBy: "Teammate", changedAt: 2 },
            };
      },
    });
    const observeWrites = vi.fn<(writes: ConfigurationItemWrites) => void>();
    function WritesProbe(): ReactNode {
      const query = useConfigurationVariablesQuery();
      const writes = useConfigurationItemWrites(query, () => undefined);
      useEffect(() => observeWrites(writes), [writes]);
      return <p>{query.data === undefined ? "loading" : query.data.length}</p>;
    }
    render(<WritesProbe />, { wrapper: harness.Wrapper });
    expect(await screen.findByText("1")).toBeTruthy();
    const getWrites = (): ConfigurationItemWrites => {
      const writes = observeWrites.mock.lastCall?.[0];
      if (writes === undefined)
        throw new Error("The item writes hook is absent.");
      return writes;
    };
    const readsBeforeWrite = harness.paramsOf(
      "environment.configuration.items",
    ).length;
    const submitted: ConfigurationItemWrite = {
      kind: "variable",
      key: "NODE_ENV",
      os: "any",
      action: "put",
      value: { value: "a" },
      original: variable("shown", 3),
    };
    let operation: Promise<void> = Promise.resolve();
    act(() => {
      operation = getWrites().write(submitted);
    });
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
    });

    const typed = { ...submitted, value: { value: "ab" } };
    act(() => getWrites().updateDraft(typed));
    items = [variable("teammate", 4)];
    await act(async () => {
      firstWrite.resolve({
        outcome: "conflict",
        current: { revision: 4, changedBy: "Teammate", changedAt: 2 },
      });
      await operation;
    });
    await waitFor(() => {
      expect(getWrites().pending).toBeNull();
      expect(getWrites().drafts).toHaveLength(1);
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(readsBeforeWrite);
    });
    await act(async () => {
      await getWrites().writeOnUnmount(typed);
    });

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "a" } }),
        expect.objectContaining({ revision: 3, value: { value: "ab" } }),
      ]);
    });
  });

  it("does not resend the submitted value when a delayed read remounts after a failed retry", async () => {
    let items = [variable("development", 1)];
    let holdReads = false;
    let delayedReadStarted = false;
    let puts = 0;
    const delayedRead = Promise.withResolvers<{
      items: EnvironmentConfigurationItem[];
    }>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => {
        if (holdReads) {
          delayedReadStarted = true;
          return delayedRead.promise;
        }
        return { items };
      },
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate-value", 2)];
          holdReads = true;
          return {
            outcome: "conflict",
            current: { revision: 2, changedBy: "Teammate", changedAt: 2 },
          };
        }
        return { outcome: "forbidden" };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("submitted");
    commitNodeValue();

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 1, value: { value: "submitted" } }),
      ]);
      expect(nodeValue()).toHaveProperty("disabled", false);
    });
    await waitFor(() => expect(delayedReadStarted).toBe(true));
    const submittedField = nodeValue();
    await userEvent.type(submittedField, "!");
    const fetchCallsBeforeRetry = vi.mocked(globalThis.fetch).mock.calls.length;
    const authnFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    if (authnFetch === undefined)
      throw new Error("The authn fetch fixture is absent.");
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      let target: string;
      if (input instanceof Request) target = input.url;
      else if (input instanceof URL) target = input.href;
      else target = input;
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        method === "PUT" &&
        new URL(target).pathname.endsWith("/items/variable")
      ) {
        throw new Error("The transport did not answer.");
      }
      return authnFetch(input, init);
    });
    commitNodeValue();
    expect(await within(nodeRegion()).findByRole("alert")).toHaveProperty(
      "textContent",
      "Connect to manage settings.",
    );
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(
      fetchCallsBeforeRetry,
    );
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      expect.objectContaining({ revision: 1, value: { value: "submitted" } }),
    ]);

    const fetchCallsBeforeReadSettles = vi.mocked(globalThis.fetch).mock.calls
      .length;
    await act(async () => {
      delayedRead.resolve({ items });
      await delayedRead.promise;
    });
    await waitFor(() => expect(nodeValue()).not.toBe(submittedField));
    expect(nodeValue()).toHaveProperty("value", "submitted!");
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(
      fetchCallsBeforeReadSettles,
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
  });

  it("does not write a submitted draft again when the conflict read remounts its row", async () => {
    let items = [variable("development", 1)];
    let holdRead = false;
    let readStarted = false;
    const delayedRead = Promise.withResolvers<{
      items: EnvironmentConfigurationItem[];
    }>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => {
        if (holdRead) {
          readStarted = true;
          return delayedRead.promise;
        }
        return { items };
      },
      "environment.configuration.items.put": () => {
        items = [variable("teammate-value", 2)];
        holdRead = true;
        return {
          outcome: "conflict",
          current: { revision: 2, changedBy: "Teammate", changedAt: 2 },
        };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("submitted");
    commitNodeValue();
    const submittedField = nodeValue();

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 1, value: { value: "submitted" } }),
      ]);
      expect(readStarted).toBe(true);
    });
    await act(async () => {
      delayedRead.resolve({ items });
      await delayedRead.promise;
    });

    await waitFor(() => expect(nodeValue()).not.toBe(submittedField));
    expect(nodeValue()).toHaveProperty("value", "submitted");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
  });

  it("writes the edited value at the last-told revision when a failed draft unmounts", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("shown", 3)],
      }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
    });
    const page = render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("first");
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(
      new Error("The transport did not answer."),
    );
    commitNodeValue();

    expect(await within(nodeRegion()).findByRole("alert")).toHaveProperty(
      "textContent",
      "Connect to manage settings.",
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    await editVariable("second");
    page.unmount();

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "second" } }),
      ]);
    });
  });

  it("writes a post-conflict edit at the refused revision when the row unmounts", async () => {
    let items = [variable("shown", 3)];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate", 4)];
          return {
            outcome: "conflict",
            current: { revision: 4, changedBy: "Teammate", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 5 };
      },
    });
    const page = render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("first");
    const readsBeforeConflict = harness.paramsOf(
      "environment.configuration.items",
    ).length;
    commitNodeValue();

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(readsBeforeConflict);
    });
    await waitFor(() => {
      expect(nodeValue()).toHaveProperty("disabled", false);
    });
    await editVariable("second");
    page.unmount();

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "first" } }),
        expect.objectContaining({ revision: 4, value: { value: "second" } }),
      ]);
    });
  });

  it("saves a held draft at the revision named by a refused Remove", async () => {
    let items = [variable("development", 1)];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate-before-remove", 2)];
          return {
            outcome: "conflict",
            current: { revision: 2, changedBy: "Teammate", changedAt: 2 },
          };
        }
        items = [variable("saved-after-remove", 4)];
        return { outcome: "saved", revision: 4 };
      },
      "environment.configuration.items.delete": () => {
        items = [variable("teammate-after-remove", 3)];
        return {
          outcome: "conflict",
          current: { revision: 3, changedBy: "Teammate", changedAt: 3 },
        };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });

    await screen.findByRole("region", { name: "NODE_ENV" });
    const readsBeforePut = harness.paramsOf(
      "environment.configuration.items",
    ).length;
    await editVariable("draft-before-remove");
    commitNodeValue();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(readsBeforePut);
    });
    const readsBeforeRemove = harness.paramsOf(
      "environment.configuration.items",
    ).length;
    await userEvent.click(
      within(nodeRegion()).getByRole("button", { name: "Remove NODE_ENV" }),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toHaveLength(1);
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(readsBeforeRemove);
    });
    await editVariable("saved-after-remove");
    commitNodeValue();

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({
          revision: 1,
          value: { value: "draft-before-remove" },
        }),
        expect.objectContaining({
          revision: 3,
          value: { value: "saved-after-remove" },
        }),
      ]);
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toEqual([expect.objectContaining({ revision: 2, key: "NODE_ENV" })]);
    });
  });

  it("keeps and saves a held draft at its last-told revision when a quiet read deletes the row", async () => {
    let items = [variable("development", 1)];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate-value", 2)];
          return {
            outcome: "conflict",
            current: { revision: 2, changedBy: "Teammate", changedAt: 2 },
          };
        }
        items = [variable("draft", 3)];
        return { outcome: "saved", revision: 3 };
      },
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });

    await screen.findByRole("region", { name: "NODE_ENV" });
    const readsBeforePut = harness.paramsOf(
      "environment.configuration.items",
    ).length;
    await editVariable("draft");
    commitNodeValue();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(readsBeforePut);
    });
    expect(nodeValue()).toHaveProperty("value", "draft");

    const readsBeforeQuietRead = harness.paramsOf(
      "environment.configuration.items",
    ).length;
    items = [];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    expect(harness.paramsOf("environment.configuration.items")).toHaveLength(
      readsBeforeQuietRead + 1,
    );
    expect(
      await screen.findByRole("region", { name: "NODE_ENV" }),
    ).toBeTruthy();
    expect(nodeValue()).toHaveProperty("value", "draft");
    commitNodeValue();

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 1, value: { value: "draft" } }),
        expect.objectContaining({ revision: 2, value: { value: "draft" } }),
      ]);
    });
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
    commitNodeValue();
    expect(
      await screen.findByText("Saved, but latest settings haven't refreshed."),
    ).toBeTruthy();
    expect(nodeValue()).toHaveProperty("value", "production");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const reads = harness.paramsOf("environment.configuration.items").length;
    failing = false;
    items = [variable("production", 2)];
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expectUnlocked();
    expect(harness.paramsOf("environment.configuration.items")).toHaveLength(
      reads + 1,
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    await editVariable("third-value");
    expect(nodeValue()).toHaveProperty("disabled", false);
    expect(nodeValue()).toHaveProperty("value", "third-value");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
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
      fireEvent.blur(nodeValue());
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
    await expectUnlocked();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    await editVariable("recovered");
    await act(async () => {
      stalled.resolve({ items: [variable("development", 1)] });
      await stalled.promise;
    });
    expect(nodeValue()).toHaveProperty("value", "recovered");
  });
});

describe("TeamTextItems editor", () => {
  it("shows a saved variable as name, value and remove, with no Set or Unset", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [variable("a", 1)] }),
    });
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    const saved = await screen.findByRole("region", { name: "NODE_ENV" });
    expect(within(saved).getByLabelText("Name for NODE_ENV")).toHaveProperty(
      "value",
      "NODE_ENV",
    );
    expect(within(saved).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "a",
    );
    expect(within(saved).queryByRole("combobox")).toBeNull();
    expect(
      within(saved).getByRole("button", { name: "Remove NODE_ENV" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByLabelText("New variable name")).toBeNull();
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
    const field = await screen.findByRole("textbox", {
      name: "Value for NODE_ENV",
    });
    await userEvent.click(field);
    expect(document.activeElement).toBe(field);
  });

  it("reveals an add row from Add a variable and commits it only from Apply", async () => {
    let items: EnvironmentConfigurationItem[] = [];
    const harness = mountEditor(
      () => ({ items }),
      () => {
        items = [
          configurationItem({
            kind: "variable",
            key: "FOO",
            os: "any",
            value: { value: "one" },
            revision: 2,
          }),
        ];
        return { outcome: "saved", revision: 2 };
      },
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    expect(await screen.findByText("No variables.")).toBeTruthy();
    await openAdd();
    expect(screen.queryByText("No variables.")).toBeNull();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "FOO" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "one" },
    });
    fireEvent.blur(screen.getByLabelText("New variable value"));
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Apply variable" }),
    );
    await expectUnlocked();
    expect(screen.getByLabelText("Value for FOO")).toHaveProperty(
      "value",
      "one",
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([{ key: "FOO", revision: null, value: { value: "one" } }]);
  });

  it("discards a new variable without writing", async () => {
    const harness = mountEditor(
      () => ({ items: [] }),
      () => ({ outcome: "saved", revision: 2 }),
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await openAdd();
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "FOO" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "one" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Discard variable" }),
    );
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(screen.getByText("No variables.")).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
  });

  it("disables Apply until the name is a variable name", async () => {
    const harness = mountEditor(
      () => ({ items: [] }),
      () => ({ outcome: "saved", revision: 2 }),
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await openAdd();
    const apply = screen.getByRole("button", { name: "Apply variable" });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "1BAD" },
    });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "A-B" },
    });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "GOOD" },
    });
    expect(apply).toHaveProperty("disabled", false);
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
  });

  it("writes a saved row's typed value when its revision changes before blur", async () => {
    let items = [variable("development", 1)];
    const harness = mountEditor(
      () => ({ items }),
      () => {
        items = [variable("typed-value", 3)];
        return { outcome: "saved", revision: 3 };
      },
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("typed-value");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    items = [variable("server-value", 2)];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    await expectUnlocked();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([
      { key: "NODE_ENV", revision: 1, value: { value: "typed-value" } },
    ]);
    expect(nodeValue()).toHaveProperty("value", "typed-value");
  });

  it("commits a changed saved value on blur", async () => {
    let items = [variable("development", 1)];
    const harness = mountEditor(
      () => ({ items }),
      () => {
        items = [variable("production", 2)];
        return { outcome: "saved", revision: 2 };
      },
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    await editVariable("production");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    commitNodeValue();
    await expectUnlocked();
    expect(nodeValue()).toHaveProperty("value", "production");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([
      { key: "NODE_ENV", revision: 1, value: { value: "production" } },
    ]);
  });

  it("commits an empty saved value", async () => {
    let items = [variable("development", 1)];
    const harness = mountEditor(
      () => ({ items }),
      () => {
        items = [variable("", 2)];
        return { outcome: "saved", revision: 2 };
      },
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    const row = await screen.findByRole("region", { name: "NODE_ENV" });
    fireEvent.change(within(row).getByLabelText("Value for NODE_ENV"), {
      target: { value: "" },
    });
    fireEvent.blur(within(row).getByLabelText("Value for NODE_ENV"));
    await expectUnlocked();
    expect(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByLabelText(
        "Value for NODE_ENV",
      ),
    ).toHaveProperty("value", "");
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([{ key: "NODE_ENV", revision: 1, value: { value: "" } }]);
  });

  it("snaps a saved name back and writes the stored key with a changed value", async () => {
    let items = [variable("development", 1)];
    const harness = mountEditor(
      () => ({ items }),
      () => {
        items = [variable("next", 2)];
        return { outcome: "saved", revision: 2 };
      },
    );
    render(<TextItemsPage />, { wrapper: harness.Wrapper });
    const row = await screen.findByRole("region", { name: "NODE_ENV" });
    fireEvent.change(within(row).getByLabelText("Name for NODE_ENV"), {
      target: { value: "RENAMED" },
    });
    fireEvent.blur(within(row).getByLabelText("Name for NODE_ENV"));
    expect(within(row).getByLabelText("Name for NODE_ENV")).toHaveProperty(
      "value",
      "NODE_ENV",
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    fireEvent.change(within(row).getByLabelText("Name for NODE_ENV"), {
      target: { value: "RENAMED" },
    });
    fireEvent.change(within(row).getByLabelText("Value for NODE_ENV"), {
      target: { value: "next" },
    });
    fireEvent.blur(within(row).getByLabelText("Name for NODE_ENV"));
    await expectUnlocked();
    const saved = screen.getByRole("region", { name: "NODE_ENV" });
    expect(within(saved).getByLabelText("Name for NODE_ENV")).toHaveProperty(
      "value",
      "NODE_ENV",
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([
      { key: "NODE_ENV", revision: 1, value: { value: "next" } },
    ]);
  });

  it("strips a provider prefix from the visible name and writes the prefixed key", async () => {
    let items = [
      configurationItem({
        kind: "env_override",
        key: "claude:ANTHROPIC_BASE_URL",
        os: "any",
        value: { value: "https://example.invalid" },
        revision: 4,
      }),
    ];
    const harness = mountEditor(
      () => ({ items }),
      () => {
        items = [
          ...items,
          configurationItem({
            kind: "env_override",
            key: "claude:FOO",
            os: "any",
            value: { value: "bar" },
            revision: 5,
          }),
        ];
        return { outcome: "saved", revision: 5 };
      },
    );
    render(<ProviderEnvPage />, { wrapper: harness.Wrapper });
    const row = await screen.findByRole("region", {
      name: "claude:ANTHROPIC_BASE_URL",
    });
    expect(
      within(row).getByLabelText("Name for ANTHROPIC_BASE_URL"),
    ).toHaveProperty("value", "ANTHROPIC_BASE_URL");
    expect(
      within(row).getByLabelText("Value for ANTHROPIC_BASE_URL"),
    ).toHaveProperty("value", "https://example.invalid");
    await openAdd();
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "FOO" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "bar" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Apply variable" }),
    );
    await expectUnlocked();
    const saved = screen.getByRole("region", { name: "claude:FOO" });
    expect(within(saved).getByLabelText("Name for FOO")).toHaveProperty(
      "value",
      "FOO",
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toMatchObject([
      {
        key: "claude:FOO",
        kind: "env_override",
        revision: null,
        value: { value: "bar" },
      },
    ]);
  });

  it("keeps the OS badge and the details slot on a saved row", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "variable",
            key: "NODE_ENV",
            os: "linux",
            value: { value: "linux-value" },
            revision: 1,
          }),
        ],
      }),
    });
    render(<DetailedItemsPage />, { wrapper: harness.Wrapper });
    const row = await screen.findByRole("region", { name: "NODE_ENV · Linux" });
    expect(within(row).getByText("Linux")).toBeTruthy();
    expect(within(row).getByText("Details NODE_ENV")).toBeTruthy();
    expect(within(row).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "linux-value",
    );
  });
});
