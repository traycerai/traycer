import "../../../../../__tests__/test-browser-apis";
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
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";
import {
  profile,
  cursorKey,
  teamProfile,
  profileTriggerName,
  openProfileMenu,
  profileRowSwitch,
  openProfileEditor,
  handlers,
} from "./team-providers-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));
vi.mock("@/components/settings/secrets/secret-row", () => ({
  SecretRow: () => null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  setSystemTabModalApi(null);
});

describe("TeamProviders profiles", () => {
  it("toggles a profile against the displayed revision, and a conflict rereads it beside the changed-by line", async () => {
    let current = profile(true, 4);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        current = profile(false, 5);
        return {
          outcome: "conflict",
          current: { revision: 5, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
    const checkboxItem = screen.getByRole("switch", {
      name: "Allow agents to use Work",
    });
    expect(checkboxItem.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(checkboxItem);

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:prof-1",
        os: null,
        value: {
          name: "Work",
          color: null,
          harnessId: "claude",
          accountIdentity: "ada@example.com",
          needsLink: false,
          enabled: false,
          mergedInto: "kept-work",
        },
        revision: 4,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: profileTriggerName("Work", true),
      }),
    ).toBeTruthy();
    await waitFor(() => {
      const updatedCheckboxItem = screen.getByRole("switch", {
        name: "Allow agents to use Work",
      });
      expect(updatedCheckboxItem.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("does not label an editor profile control Use", async () => {
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers(() => [profile(true, 4)]),
    );
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Work")).toBeTruthy();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Use Work" })).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("lists every team profile and writes each row switch with that item's revision and stored record", async () => {
    const workValue = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const homeValue = {
      name: "Home",
      color: null,
      harnessId: "claude",
      accountIdentity: "Home label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-home",
    };
    const work = configurationItem({
      kind: "managed_profile",
      key: "claude:work",
      value: workValue,
      revision: 4,
    });
    const home = configurationItem({
      kind: "managed_profile",
      key: "claude:home",
      value: homeValue,
      revision: 9,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work, home]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 10,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const trigger = await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const profileSection = trigger.closest("section");
    if (!(profileSection instanceof HTMLElement)) {
      throw new Error("The configuration profile picker must have a section.");
    }
    const account = screen.getByText("Work label");
    expect(
      trigger.compareDocumentPosition(account) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Home label")).toBeNull();
    openProfileMenu(profileTriggerName("Work", false));
    const workRow = screen.getByRole("menuitem", { name: "Work" });
    const homeRow = screen.getByRole("menuitem", { name: "Home" });
    expect(
      workRow.compareDocumentPosition(homeRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "Create new profile" }),
    ).toBeNull();
    const plansSignIn = screen.getByRole("button", { name: "Sign in" });
    expect(profileSection.contains(plansSignIn)).toBe(false);
    expect(
      within(profileSection).queryByRole("button", { name: "Sign in" }),
    ).toBeNull();
    expect(
      within(profileSection).queryByRole("button", { name: "Add a profile" }),
    ).toBeNull();
    expect(
      within(profileSection).queryByRole("button", {
        name: "Create new profile",
      }),
    ).toBeNull();

    fireEvent.click(profileRowSwitch("Home"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:home",
          os: null,
          value: { ...homeValue, enabled: false },
          revision: 9,
        },
      ]);
    });
    fireEvent.click(profileRowSwitch("Work"));
    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:home",
          os: null,
          value: { ...homeValue, enabled: false },
          revision: 9,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...workValue, enabled: false },
          revision: 4,
        },
      ]);
    });
  });

  it("gives a viewer On/Off for a profile with no switch, plus the member-only verbs withheld", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => [profile(true, 4)]),
      "environment.secrets.list": () => ({
        secrets: [
          cursorKey,
          { ...cursorKey, secretId: "second-key", name: "OPENAI_API_KEY" },
        ],
        removed: [],
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    const identity = await screen.findByText("ada@example.com");
    expect(identity.className).toContain("whitespace-normal");
    expect(identity.className).toContain("break-words");
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByText("Use")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Key" })).toBeNull();
    expect(screen.queryByText("CURSOR_API_KEY")).toBeNull();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Secrets" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull();
    expect(
      screen.getByRole("button", { name: profileTriggerName("Work", false) }),
    ).toBeTruthy();
  });

  it("lets a reader select a disabled profile and keeps On or Off with no Manage", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...handlers(() => [
        teamProfile({
          key: "claude:work",
          name: "Work",
          revision: 4,
          enabled: true,
          mergedInto: "kept-work",
          accountIdentity: "Work label",
        }),
        teamProfile({
          key: "claude:home",
          name: "Home",
          revision: 8,
          enabled: false,
          mergedInto: "kept-home",
          accountIdentity: "Home label",
        }),
      ]),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    openProfileMenu(profileTriggerName("Work", false));
    const homeGroup = screen.getByRole("group", {
      name: "Home profile controls",
    });
    expect(within(homeGroup).getByText("Off")).toBeTruthy();
    expect(within(homeGroup).queryByRole("switch")).toBeNull();
    const homeRow = within(homeGroup).getByRole("menuitem", {
      name: "Home, Disabled",
    });
    expect(homeRow.getAttribute("aria-disabled")).not.toBe("true");
    const workGroup = screen.getByRole("group", {
      name: "Work profile controls",
    });
    expect(within(workGroup).getByText("On")).toBeTruthy();
    expect(within(workGroup).queryByRole("switch")).toBeNull();
    fireEvent.click(homeRow);

    expect(
      await screen.findByRole("button", {
        name: profileTriggerName("Home", true),
      }),
    ).toBeTruthy();
    expect(screen.getByText("Home label")).toBeTruthy();
    expect(screen.queryByText("Work label")).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a profile" })).toBeNull();
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("renames the selected profile through Manage and keeps the stored record", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 5,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    expect(within(dialog).getByText("Update how Work appears.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: "Desk",
            color: null,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 4,
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Edit profile" })).toBeNull();
    });
  });

  it("recolors the selected profile through Manage and warns when another profile uses that color", async () => {
    const sharedColor = "#3b82f6";
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 6,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const home = teamProfile({
      key: "claude:home",
      name: "Home",
      revision: 2,
      enabled: true,
      mergedInto: "kept-home",
      accountIdentity: "Home label",
      color: sharedColor,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work, home]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 7,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    expect(within(dialog).queryByText(/already uses this color/)).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${sharedColor}` }),
    );
    expect(
      within(dialog).getByText(/Home already uses this color/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: "Work",
            color: sharedColor,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 6,
        },
      ]);
    });
  });

  it("removes the selected profile through Manage at its revision", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 11,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.delete": () => ({
        outcome: "saved",
        revision: null,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove profile" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Remove Work?",
    });
    expect(
      within(confirm).getByText("Remove this profile from the team."),
    ).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          revision: 11,
        },
      ]);
    });
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
  });

  it("refuses a blank profile name and a name past 64 characters, and saves a name at the limit", async () => {
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 3,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const limit = "a".repeat(64);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const nameField = within(dialog).getByLabelText("Profile name");
    expect(nameField).toHaveProperty("maxLength", 64);
    fireEvent.change(nameField, { target: { value: "   " } });
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(nameField, { target: { value: "a".repeat(65) } });
    expect(nameField).toHaveProperty("value", "a".repeat(65));
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([]);
    fireEvent.change(nameField, { target: { value: limit } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: {
            name: limit,
            color: null,
            harnessId: "claude",
            accountIdentity: "Work label",
            needsLink: false,
            enabled: true,
            mergedInto: "kept-work",
          },
          revision: 3,
        },
      ]);
    });
  });

  it("leaves the edit dialog open when a rename conflicts", async () => {
    const putDispatched = Promise.withResolvers<void>();
    const putResponse =
      Promise.withResolvers<EnvironmentConfigurationItemWriteResponse>();
    const work = teamProfile({
      key: "claude:work",
      name: "Work",
      revision: 4,
      enabled: true,
      mergedInto: "kept-work",
      accountIdentity: "Work label",
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [work]),
      "environment.configuration.items.put": () => {
        putDispatched.resolve();
        return putResponse.promise;
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await putDispatched.promise;

    const spinner = await within(dialog).findByText(
      (_, element) =>
        element instanceof HTMLSpanElement &&
        element.getAttribute("aria-hidden") === "true" &&
        element.classList.contains("font-mono") &&
        element.classList.contains("text-code") &&
        element.textContent.trim() !== "",
    );
    expect(spinner).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toHaveProperty("disabled", true);
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeTruthy();

    const backdrop = document.querySelector("[data-slot='dialog-overlay']");
    if (backdrop === null)
      throw new Error("Edit dialog backdrop was not rendered");
    await userEvent.click(backdrop);
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeTruthy();

    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancelButton).toHaveProperty("disabled", true);
    await userEvent.click(cancelButton);
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeTruthy();

    await act(async () => {
      putResponse.resolve({
        outcome: "conflict",
        current: { revision: 5, changedBy: "Nora", changedAt: 2 },
      });
      await putResponse.promise;
    });

    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    const completedDialog = screen.getByRole("dialog", {
      name: "Edit profile",
    });
    expect(
      within(completedDialog).getByRole("button", { name: "Close" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Profile name")).toHaveProperty(
      "value",
      "Desk",
    );
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "managed_profile",
        key: "claude:work",
        os: null,
        value: {
          name: "Desk",
          color: null,
          harnessId: "claude",
          accountIdentity: "Work label",
          needsLink: false,
          enabled: true,
          mergedInto: "kept-work",
        },
        revision: 4,
      },
    ]);
    expect(harness.paramsOf("environment.configuration.items.delete")).toEqual(
      [],
    );
  });

  it("retries a rename after a conflict with the colour from the re-read", async () => {
    const stored = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const teammateColor = "#3b82f6";
    const reread = { ...stored, color: teammateColor };
    let current = teamProfile({
      key: "claude:work",
      name: stored.name,
      revision: 4,
      enabled: stored.enabled,
      mergedInto: stored.mergedInto,
      accountIdentity: stored.accountIdentity,
      color: stored.color,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        if (current.revision === 4) {
          current = teamProfile({
            key: "claude:work",
            name: reread.name,
            revision: 5,
            enabled: reread.enabled,
            mergedInto: reread.mergedInto,
            accountIdentity: reread.accountIdentity,
            color: reread.color,
          });
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Nora", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 6 };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const reads = harness.paramsOf("environment.configuration.items").length;
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Desk" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...stored, name: "Desk" },
          revision: 4,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...reread, name: "Desk" },
          revision: 5,
        },
      ]);
    });
  });

  it("retries a recolor after a conflict with the name from the re-read", async () => {
    const stored = {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "Work label",
      needsLink: false,
      enabled: true,
      mergedInto: "kept-work",
    };
    const pickedColor = "#ef4444";
    const reread = { ...stored, name: "Home" };
    let current = teamProfile({
      key: "claude:work",
      name: stored.name,
      revision: 4,
      enabled: stored.enabled,
      mergedInto: stored.mergedInto,
      accountIdentity: stored.accountIdentity,
      color: stored.color,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers(() => [current]),
      "environment.configuration.items.put": () => {
        if (current.revision === 4) {
          current = teamProfile({
            key: "claude:work",
            name: reread.name,
            revision: 5,
            enabled: reread.enabled,
            mergedInto: reread.mergedInto,
            accountIdentity: reread.accountIdentity,
            color: reread.color,
          });
          return {
            outcome: "conflict",
            current: { revision: 5, changedBy: "Nora", changedAt: 2 },
          };
        }
        return { outcome: "saved", revision: 6 };
      },
    });
    render(<TeamProviders />, { wrapper: harness.Wrapper });

    await screen.findByRole("button", {
      name: profileTriggerName("Work", false),
    });
    const dialog = await openProfileEditor();
    const reads = harness.paramsOf("environment.configuration.items").length;
    await userEvent.click(
      within(dialog).getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText("Changed by Nora a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...stored, color: pickedColor },
          revision: 4,
        },
        {
          environmentId: "env-a",
          kind: "managed_profile",
          key: "claude:work",
          os: null,
          value: { ...reread, color: pickedColor },
          revision: 5,
        },
      ]);
    });
  });
});
