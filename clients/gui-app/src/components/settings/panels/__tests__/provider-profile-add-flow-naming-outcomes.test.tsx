import {
  MINTED_PROFILE_ID,
  PROFILE_RECORD_URL,
  profileNameTransport,
  ADD_FLOW_DEFAULTS,
  sameEmailRenameProfiles,
  createAddProfileNameAuthFixture,
  renderAddFlow,
  methodCount,
  pressAccount,
  renamedLabel,
  setEnabledActionDetails,
  mintedSignedInRow,
} from "./provider-profile-add-flow-sign-in-outcomes-test-support";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_PROFILE_ACCENT_COLORS } from "@traycer/protocol/host/provider-schemas";

describe("Add a profile around one sign-in", () => {
  it("keeps linked copy when the profile color save fails without sign-in offers", async () => {
    const linked = mintedSignedInRow();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: false,
      profilesBefore: [],
      profilesAfter: [linked],
      outcome: null,
      echoedProfiles: [linked],
      failRecolor: true,
      freshlyLinkedProfile: true,
    });
    await pressAccount(false);
    await waitFor(() => {
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
        1,
      );
    });

    expect(
      await screen.findByText(
        "The account was linked, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      1,
    );
    expect(harness.created).not.toHaveBeenCalled();
  });

  it.each([true, "10.11"] as const)(
    "finishes a distinct-email sign-in without a naming step when offersSignIns is %s",
    async (offers) => {
      const row: ProviderProfile = {
        ...mintedSignedInRow(),
        identity: {
          email: "fresh@example.test",
          tier: "Team",
          accountUuid: null,
        },
        accentColor: PROVIDER_PROFILE_ACCENT_COLORS[0],
      };
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [row],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [row],
        echoedExistingProfileId: null,
        seedCache: true,
      });
      await pressAccount(offers);
      expect(
        screen.queryByText(
          "Terminal account already uses this email. Name this profile so you can tell them apart.",
        ),
      ).toBeNull();
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );

  it.each([true, "10.11"] as const)(
    "names a same-email distinct profile through the real dialog with offersSignIns %s",
    async (offers) => {
      const { existing, created } = sameEmailRenameProfiles();
      const auth =
        offers === true
          ? await createAddProfileNameAuthFixture("accepted")
          : null;
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [existing, created],
        echoedExistingProfileId: null,
        seedCache: offers === true,
        authService: auth?.service ?? null,
        recordEnvironment: offers === true,
      });
      profileNameTransport.onAccepted = (name) =>
        harness.updateProfileName(MINTED_PROFILE_ID, name);
      await pressAccount(offers);
      expect(
        await screen.findByText(
          "Terminal account already uses this email. Name this profile so you can tell them apart.",
        ),
      ).toBeTruthy();
      if (offers === true) {
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
        expect(
          methodCount(harness.messenger.calls, "providers.setEnabled"),
        ).toBe(0);
      }
      fireEvent.change(screen.getByLabelText("Profile name"), {
        target: { value: "Personal" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
          methodCount(harness.messenger.calls, "providers.setEnabled"),
        ).toBe(offers === true ? 0 : 1);
        if (offers === true) {
          expect(methodCount(harness.messenger.calls, "providers.list")).toBe(
            2,
          );
        }
      });
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(
        harness.calls
          .filter((call) => call.method === "providers.setEnabled")
          .map((call) => renamedLabel(call.params)),
      ).toEqual(offers === true ? [] : ["Personal"]);
      expect(auth?.requests ?? []).toEqual(
        offers === true
          ? [
              {
                url: PROFILE_RECORD_URL,
                method: "POST",
                body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
              },
            ]
          : [],
      );
      expect(
        methodCount(harness.messenger.calls, "providers.cancelLogin"),
      ).toBe(0);
    },
  );

  it.each([true, "10.11"] as const)(
    "keeps the naming step open after a failed save and allows retry with offersSignIns %s",
    async (offers) => {
      const { existing, created } = sameEmailRenameProfiles();
      const auth =
        offers === true
          ? await createAddProfileNameAuthFixture("retry-once")
          : null;
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [existing, created],
        echoedExistingProfileId: null,
        renameFailures: offers === "10.11" ? 1 : 0,
        seedCache: offers === true,
        authService: auth?.service ?? null,
        recordEnvironment: offers === true,
      });
      profileNameTransport.onAccepted = (name) =>
        harness.updateProfileName(MINTED_PROFILE_ID, name);
      await pressAccount(offers);
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      );
      fireEvent.change(screen.getByLabelText("Profile name"), {
        target: { value: "Personal" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      const retryMessage =
        offers === true
          ? "Couldn't rename profile."
          : "Couldn't save the name. Try again.";
      expect(await screen.findByText(retryMessage)).toBeTruthy();
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save profile" })).toBeTruthy();
      expect(harness.created).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(
        harness.calls
          .filter((call) => call.method === "providers.setEnabled")
          .map((call) => renamedLabel(call.params)),
      ).toEqual(offers === true ? [] : ["Personal", "Personal"]);
      expect(auth?.requests ?? []).toEqual(
        offers === true
          ? [
              {
                url: PROFILE_RECORD_URL,
                method: "POST",
                body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
              },
              {
                url: PROFILE_RECORD_URL,
                method: "POST",
                body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
              },
            ]
          : [],
      );
    },
  );

  it.each([true, "10.11"] as const)(
    "renames and recolors a same-email distinct profile with offersSignIns %s",
    async (offers) => {
      const { existing, created } = sameEmailRenameProfiles();
      const auth =
        offers === true
          ? await createAddProfileNameAuthFixture("accepted")
          : null;
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [existing, created],
        echoedExistingProfileId: null,
        seedCache: true,
        authService: auth?.service ?? null,
        recordEnvironment: offers === true,
      });
      profileNameTransport.onAccepted = (name) =>
        harness.updateProfileName(MINTED_PROFILE_ID, name);
      await pressAccount(offers);
      expect(
        await screen.findByText(
          "Terminal account already uses this email. Name this profile so you can tell them apart.",
        ),
      ).toBeTruthy();
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
      }
      fireEvent.change(screen.getByLabelText("Profile name"), {
        target: { value: "Personal" },
      });
      const pickedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
      expect(pickedColor).not.toBe(existing.accentColor);
      fireEvent.click(
        screen.getByRole("button", { name: `Use color ${pickedColor}` }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => {
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(
          offers === true ? 1 : 2,
        );
      });
      const setEnabledCalls = harness.calls.filter(
        (call) => call.method === "providers.setEnabled",
      );
      expect(
        setEnabledCalls.map((call) => setEnabledActionDetails(call.params)),
      ).toEqual(
        offers === true
          ? [{ label: null, accentColor: pickedColor }]
          : [
              { label: "Personal", accentColor: null },
              { label: null, accentColor: pickedColor },
            ],
      );
      expect(auth?.requests ?? []).toEqual(
        offers === true
          ? [
              {
                url: PROFILE_RECORD_URL,
                method: "POST",
                body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
              },
            ]
          : [],
      );
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(2);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
      }
      harness.releaseRecolor();
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(3);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(3);
      }
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(
        methodCount(harness.messenger.calls, "providers.cancelLogin"),
      ).toBe(0);
    },
  );

  it("keeps a legacy authenticated profile name on the computer rename path", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture("forbidden");
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: null,
      echoedProfiles: [existing, created],
      freshlyLinkedProfile: true,
      seedCache: true,
      authService: auth.service,
    });
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
        1,
      );
    });
    expect(
      harness.calls
        .filter((call) => call.method === "providers.setEnabled")
        .map((call) => renamedLabel(call.params)),
    ).toEqual(["Personal"]);
    expect(auth.requests).toEqual([]);
    expect(methodCount(harness.messenger.calls, "environment.status")).toBe(0);
    expect(methodCount(harness.messenger.calls, "environment.host.read")).toBe(
      0,
    );
  });

  it.each([
    { reply: "unauthorized" as const, message: "Please sign in again." },
    {
      reply: "forbidden" as const,
      message: "You don't have permission to do that.",
    },
    {
      reply: "untyped-failure" as const,
      message: "Couldn't rename profile.",
    },
  ])(
    "shows the safe $reply name failure and keeps naming available",
    async ({ reply, message }) => {
      const { existing, created } = sameEmailRenameProfiles();
      const auth = await createAddProfileNameAuthFixture(reply);
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
        echoedProfiles: [existing, created],
        seedCache: true,
        authService: auth.service,
        recordEnvironment: true,
      });
      await pressAccount(true);
      expect(
        await screen.findByText(
          "Terminal account already uses this email. Name this profile so you can tell them apart.",
        ),
      ).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Profile name"), {
        target: { value: "Personal" },
      });
      const listReadsBeforeSave = methodCount(
        harness.messenger.calls,
        "providers.list",
      );
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByText("private response detail")).toBeNull();
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(
        screen.getByRole<HTMLInputElement>("textbox", {
          name: "Profile name",
        }).value,
      ).toBe("Personal");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Save profile" })
          .disabled,
      ).toBe(false);
      expect(harness.created).not.toHaveBeenCalled();
      expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
        0,
      );
      expect(auth.requests).toEqual([
        {
          url: PROFILE_RECORD_URL,
          method: "POST",
          body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
        },
      ]);
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.list"),
        ).toBeGreaterThan(listReadsBeforeSave);
      });
      expect(harness.created).not.toHaveBeenCalled();
      expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
        0,
      );
    },
  );

  it("keeps the legacy local naming error sentence after a failed computer rename", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture("accepted");
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: null,
      echoedProfiles: [existing, created],
      freshlyLinkedProfile: true,
      seedCache: true,
      failRename: true,
      authService: auth.service,
    });
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(
      await screen.findByText("Couldn't save the name. Try again."),
    ).toBeTruthy();
    expect(screen.queryByText("synthetic rename failure")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Profile name",
      }).value,
    ).toBe("Personal");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save profile" })
        .disabled,
    ).toBe(false);
    expect(harness.created).not.toHaveBeenCalled();
    expect(
      harness.calls
        .filter((call) => call.method === "providers.setEnabled")
        .map((call) => renamedLabel(call.params)),
    ).toEqual(["Personal"]);
    expect(auth.requests).toEqual([]);
    expect(methodCount(harness.messenger.calls, "environment.status")).toBe(0);
    expect(methodCount(harness.messenger.calls, "environment.host.read")).toBe(
      0,
    );
  });
});
