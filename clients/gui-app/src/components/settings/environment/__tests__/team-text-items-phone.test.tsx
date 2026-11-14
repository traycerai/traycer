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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentConfigurationItem,
  EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import { ConfigurationSourceContext } from "@/components/settings/environment/configuration-source";
import { TeamTextItems } from "@/components/settings/environment/team-text-items";
import { useConfigurationItemWrites } from "@/components/settings/environment/configuration-item-writes";
import { useConfigurationProviderItemsQuery } from "@/hooks/environment/team/use-provider-items-query";
import { useConfigurationVariablesQuery } from "@/hooks/environment/team/use-variables-query";
import { PhoneTheme } from "@/components/settings/__tests__/phone-theme";
import {
  installPhoneViewport,
  resizePhoneViewport,
  restorePhoneViewport,
} from "@/components/settings/__tests__/phone-viewport";
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

beforeEach(() => {
  installPhoneViewport(639);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  restorePhoneViewport();
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

function renderPhone(ui: ReactNode, harness: TeamPageHarness) {
  return render(<PhoneTheme>{ui}</PhoneTheme>, { wrapper: harness.Wrapper });
}

const variable = (
  value: string,
  revision: number,
  os: EnvironmentOs,
): EnvironmentConfigurationItem =>
  configurationItem({
    kind: "variable",
    key: "NODE_ENV",
    os,
    value: { value },
    revision,
  });

function previewButton(name: string, value: string): HTMLElement {
  // The open sheet hides the page behind it; the preview row is still there.
  return screen.getByRole("button", {
    hidden: true,
    name: (accessibleName) =>
      accessibleName.includes(name) && accessibleName.includes(value),
  });
}

async function openPreview(name: string, value: string): Promise<HTMLElement> {
  await userEvent.click(previewButton(name, value));
  return screen.findByRole("dialog");
}

async function expectUnlocked(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByRole("status")).toBeNull();
  });
}

function saved(revision: number): EnvironmentConfigurationItemWriteResponse {
  return { outcome: "saved", revision };
}

describe("TeamTextItems on a phone", () => {
  it("rests as a name and value preview, with no fields", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("development", 4, "any")],
      }),
    });
    renderPhone(<TextItemsPage />, harness);

    const region = await screen.findByRole("region", { name: "NODE_ENV" });
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const row = previewButton("NODE_ENV", "development");
    expect(row.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
  });

  it("opens the bottom sheet on the saved name and value", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("development", 4, "any")],
      }),
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });

    const dialog = await openPreview("NODE_ENV", "development");

    expect(dialog.getAttribute("data-vaul-drawer-direction")).toBe("bottom");
    expect(
      within(dialog).getByRole("heading", { name: "NODE_ENV" }),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Name for NODE_ENV")).toHaveProperty(
      "value",
      "NODE_ENV",
    );
    const value = within(dialog).getByLabelText("Value for NODE_ENV");
    expect(value.tagName).toBe("TEXTAREA");
    expect(value).toHaveProperty("value", "development");
    expect(
      within(dialog).getByRole("button", { name: "Remove NODE_ENV" }),
    ).toHaveProperty("textContent", "Remove");
    expect(within(dialog).getByRole("button", { name: "Save" })).toHaveProperty(
      "textContent",
      "Save",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveProperty("textContent", "Cancel");
  });

  it("keeps a saved name read-only and writes only a new value", async () => {
    let items = [variable("", 4, "any")];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        items = [variable("filled", 5, "any")];
        return saved(5);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "");
    const name = within(dialog).getByLabelText("Name for NODE_ENV");
    await userEvent.type(name, "RENAMED");
    expect(name).toHaveProperty("value", "NODE_ENV");

    await userEvent.type(
      within(dialog).getByLabelText("Value for NODE_ENV"),
      "filled",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await expectUnlocked();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "any",
        revision: 4,
        value: { value: "filled" },
      },
    ]);
    expect(previewButton("NODE_ENV", "filled")).toBeTruthy();
    expect(screen.queryByText("RENAMED")).toBeNull();
  });

  it("writes the original key, scope and revision for a changed value", async () => {
    let items = [variable("development", 4, "linux")];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        items = [variable("next", 5, "linux")];
        return saved(5);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV · Linux" });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "next" },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await expectUnlocked();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "linux",
        revision: 4,
        value: { value: "next" },
      },
    ]);
    expect(previewButton("NODE_ENV", "next")).toBeTruthy();
  });

  it("uses the other OS row's shown revision after discarding a same-key draft", async () => {
    let items = [
      variable("development", 4, "any"),
      variable("linux-value", 9, "linux"),
    ];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [
            variable("teammate-value", 5, "any"),
            variable("linux-value", 9, "linux"),
          ];
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Teammate", changedAt: 2 },
          };
        }
        items = [
          variable("teammate-value", 5, "any"),
          variable("linux-next", 10, "linux"),
        ];
        return saved(10);
      },
    });
    renderPhone(<TextItemsPage />, harness);

    await screen.findByRole("region", { name: "NODE_ENV" });
    const anyDialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(anyDialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "abandoned-draft" },
    });
    await userEvent.click(
      within(anyDialog).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
    });
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    const linuxDialog = await openPreview("NODE_ENV", "linux-value");
    fireEvent.change(within(linuxDialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "linux-next" },
    });
    await userEvent.click(
      within(linuxDialog).getByRole("button", { name: "Save" }),
    );

    await expectUnlocked();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "any",
        revision: 4,
        value: { value: "abandoned-draft" },
      },
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "linux",
        revision: 9,
        value: { value: "linux-next" },
      },
    ]);
  });

  it("retries a refused phone draft on Save at the revision named by the refusal", async () => {
    let items = [variable("development", 3, "any")];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate", 4, "any")];
          return {
            outcome: "conflict",
            current: { revision: 4, changedBy: "Teammate", changedAt: 2 },
          };
        }
        items = [variable("draft!", 5, "any")];
        return saved(5);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "draft" },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "draft" } }),
      ]);
      expect(
        within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
      ).toHaveProperty("disabled", false);
    });
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
    ).toHaveProperty("value", "draft");
    fireEvent.change(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
      { target: { value: "draft!" } },
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "draft" } }),
        expect.objectContaining({ revision: 4, value: { value: "draft!" } }),
      ]);
    });
  });

  it("keeps a phone draft at the last-told revision through a quiet newer read", async () => {
    let items = [variable("development", 3, "any")];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate", 4, "any")];
          return {
            outcome: "conflict",
            current: { revision: 4, changedBy: "Teammate", changedAt: 2 },
          };
        }
        if (puts === 2) {
          items = [variable("newer-teammate", 5, "any")];
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Teammate", changedAt: 3 },
          };
        }
        items = [variable("draft!", 6, "any")];
        return saved(6);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "draft" },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
      expect(
        within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
      ).toHaveProperty("disabled", false);
    });
    fireEvent.change(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
      { target: { value: "draft!" } },
    );
    items = [variable("quiet-change", 5, "any")];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Save",
        }),
      ).toHaveProperty("disabled", false);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
    ).toHaveProperty("value", "draft!");

    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "draft" } }),
        expect.objectContaining({ revision: 4, value: { value: "draft!" } }),
      ]);
      expect(
        within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
      ).toHaveProperty("disabled", false);
    });
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 3, value: { value: "draft" } }),
        expect.objectContaining({ revision: 4, value: { value: "draft!" } }),
        expect.objectContaining({ revision: 5, value: { value: "draft!" } }),
      ]);
    });
  });

  it("retries a transport-failed phone save after the new revision is named", async () => {
    let items = [variable("development", 1, "any")];
    let puts = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          items = [variable("teammate", 2, "any")];
          return {
            outcome: "conflict",
            current: { revision: 2, changedBy: "Teammate", changedAt: 2 },
          };
        }
        items = [variable("draft", 3, "any")];
        return saved(3);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "draft" },
    });
    const requestStart = vi.mocked(globalThis.fetch).mock.calls.length;
    const authnFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    if (authnFetch === undefined)
      throw new Error("The authn fetch fixture is absent.");
    let rejectFirstPut = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : input);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        rejectFirstPut &&
        method === "PUT" &&
        target.pathname.endsWith("/items/variable")
      ) {
        rejectFirstPut = false;
        throw new Error("The transport did not answer.");
      }
      return authnFetch(input, init);
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(screen.getByRole("dialog")).findByRole("alert"),
    ).toHaveProperty("textContent", "Connect to manage settings.");
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(
      requestStart,
    );
    const failedRequest = vi.mocked(globalThis.fetch).mock.calls[requestStart];
    expect(failedRequest[1]?.method).toBe("PUT");
    expect(failedRequest[1]?.body).toContain('"revision":1');

    items = [variable("teammate", 2, "any")];
    await act(async () => {
      await harness.queryClient.refetchQueries();
    });
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
    ).toHaveProperty("value", "draft");
    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Save",
        }),
      ).toHaveProperty("disabled", false);
    });
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 1, value: { value: "draft" } }),
      ]);
      expect(
        within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
      ).toHaveProperty("disabled", false);
    });
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
    ).toHaveProperty("value", "draft");
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        expect.objectContaining({ revision: 1, value: { value: "draft" } }),
        expect.objectContaining({ revision: 2, value: { value: "draft" } }),
      ]);
    });
  });

  it("does not write on blur or Cancel", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("development", 4, "any")],
      }),
      "environment.configuration.items.put": () => saved(5),
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "development");
    const value = within(dialog).getByLabelText("Value for NODE_ENV");
    fireEvent.change(value, { target: { value: "draft-value" } });
    fireEvent.blur(value);

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
    expect(value).toHaveProperty("value", "draft-value");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewButton("NODE_ENV", "development")).toBeTruthy();
    expect(screen.queryByText("draft-value")).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("removes the original key, scope and revision from the sheet", async () => {
    let items = [variable("development", 4, "linux")];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.delete": () => {
        items = [];
        return saved(5);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV · Linux" });
    const dialog = await openPreview("NODE_ENV", "development");

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove NODE_ENV" }),
    );

    await expectUnlocked();
    expect(harness.paramsOf("environment.configuration.items.delete")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "linux",
        revision: 4,
      },
    ]);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
    expect(
      screen.queryByRole("region", { name: "NODE_ENV · Linux" }),
    ).toBeNull();
  });

  it("opens an empty add sheet and writes a new variable only from Save", async () => {
    let items: EnvironmentConfigurationItem[] = [];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        items = [
          configurationItem({
            kind: "variable",
            key: "FOO",
            os: "any",
            value: { value: "one" },
            revision: 2,
          }),
        ];
        return saved(2);
      },
    });
    renderPhone(<TextItemsPage />, harness);
    expect(await screen.findByText("No variables.")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Add a variable" }),
    ).toBeTruthy();
    const name = within(dialog).getByLabelText("New variable name");
    const value = within(dialog).getByLabelText("New variable value");
    expect(name).toHaveProperty("value", "");
    expect(value.tagName).toBe("TEXTAREA");
    expect(value).toHaveProperty("value", "");
    expect(
      within(dialog).queryByRole("button", { name: /^Remove/ }),
    ).toBeNull();
    const apply = within(dialog).getByRole("button", { name: "Save" });
    expect(apply).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(name).toHaveProperty("readOnly", false);
    await userEvent.type(name, "1BAD");
    expect(name).toHaveProperty("value", "1BAD");
    expect(apply).toHaveProperty("disabled", true);
    await userEvent.clear(name);
    await userEvent.type(name, "FOO");
    fireEvent.change(value, { target: { value: "one" } });
    fireEvent.blur(value);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);

    await userEvent.click(apply);

    await expectUnlocked();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "FOO",
        os: "any",
        revision: null,
        value: { value: "one" },
      },
    ]);
    expect(previewButton("FOO", "one")).toBeTruthy();
  });

  it("drops the editor when the same page becomes read-only", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("development", 4, "any")],
      }),
    });
    const view = renderPhone(
      <ConfigurationSourceContext.Provider value={poolSource("editor")}>
        <TextItemsPage />
      </ConfigurationSourceContext.Provider>,
      harness,
    );

    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "development");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewButton("NODE_ENV", "development")).toBeTruthy();

    view.rerender(
      <PhoneTheme>
        <ConfigurationSourceContext.Provider value={poolSource("viewer")}>
          <TextItemsPage />
        </ConfigurationSourceContext.Provider>
      </PhoneTheme>,
    );

    const region = screen.getByRole("region", { name: "NODE_ENV" });
    expect(within(region).queryByRole("button")).toBeNull();
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(region.querySelector("svg")).toBeNull();
    expect(region.textContent).toContain("NODE_ENV");
    expect(region.textContent).toContain("development");
    expect(screen.queryByRole("button", { name: "Add a variable" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([640, 767])(
    "keeps inline blur commit after widening to %ipx",
    async (width) => {
      let items = [variable("development", 4, "linux")];
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({ items }),
        "environment.configuration.items.put": () => {
          items = [variable("production", 5, "linux")];
          return saved(5);
        },
      });
      renderPhone(<TextItemsPage />, harness);

      await screen.findByRole("region", { name: "NODE_ENV · Linux" });
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(previewButton("NODE_ENV", "development")).toBeTruthy();

      act(() => {
        resizePhoneViewport(width);
      });

      const field = screen.getByRole("textbox", { name: "Value for NODE_ENV" });
      expect(field.tagName).toBe("INPUT");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.change(field, { target: { value: "production" } });
      fireEvent.blur(field);

      await expectUnlocked();
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "variable",
          key: "NODE_ENV",
          os: "linux",
          revision: 4,
          value: { value: "production" },
        },
      ]);
    },
  );

  it("writes a provider env value to the original prefixed key", async () => {
    let items = [
      configurationItem({
        kind: "env_override",
        key: "claude:ANTHROPIC_BASE_URL",
        os: "macos",
        value: { value: "https://example.invalid" },
        revision: 4,
      }),
    ];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => {
        items = [
          configurationItem({
            kind: "env_override",
            key: "claude:ANTHROPIC_BASE_URL",
            os: "macos",
            value: { value: "https://next.invalid" },
            revision: 5,
          }),
        ];
        return saved(5);
      },
    });
    renderPhone(<ProviderEnvPage />, harness);
    await screen.findByRole("region", {
      name: "claude:ANTHROPIC_BASE_URL · macOS",
    });
    const dialog = await openPreview(
      "ANTHROPIC_BASE_URL",
      "https://example.invalid",
    );
    expect(
      within(dialog).getByRole("heading", { name: "ANTHROPIC_BASE_URL" }),
    ).toBeTruthy();
    const name = within(dialog).getByLabelText("Name for ANTHROPIC_BASE_URL");
    expect(name).toHaveProperty("value", "ANTHROPIC_BASE_URL");
    expect(name).toHaveProperty("readOnly", true);
    fireEvent.change(
      within(dialog).getByLabelText("Value for ANTHROPIC_BASE_URL"),
      { target: { value: "https://next.invalid" } },
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await expectUnlocked();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "env_override",
        key: "claude:ANTHROPIC_BASE_URL",
        os: "macos",
        revision: 4,
        value: { value: "https://next.invalid" },
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      previewButton("ANTHROPIC_BASE_URL", "https://next.invalid"),
    ).toBeTruthy();
  });

  it("keeps Saving and a refusal inside the sheet", async () => {
    const items = [variable("development", 7, "any")];
    const write =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items }),
      "environment.configuration.items.put": () => write.promise,
    });
    renderPhone(<TextItemsPage />, harness);
    await screen.findByRole("region", { name: "NODE_ENV" });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "production" },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    const saving = screen.getByRole("dialog");
    expect(within(saving).getByRole("status")).toHaveProperty(
      "textContent",
      "NODE_ENV · Saving",
    );
    expect(within(saving).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "production",
    );
    expect(within(saving).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(previewButton("NODE_ENV", "development")).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "any",
        revision: 7,
        value: { value: "production" },
      },
    ]);

    await act(async () => {
      write.reject(new Error("the cloud could not be reached"));
      await write.promise.catch(() => undefined);
    });

    const refused = screen.getByRole("dialog");
    expect(within(refused).getByRole("alert")).toHaveProperty(
      "textContent",
      "Cloud service is temporarily unavailable. Please try again shortly.",
    );
    expect(within(refused).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "production",
    );
    expect(within(refused).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(1);
  });
});
