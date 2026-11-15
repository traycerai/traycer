import {
  openLinkMock,
  PROFILE_ID,
  MINTED_PROFILE_ID,
  PROFILE_RECORD_URL,
  profileNameTransport,
  ADD_FLOW_DEFAULTS,
  workProfile,
  sameEmailRenameProfiles,
  createAddProfileNameAuthFixture,
  renderAddFlow,
  methodCount,
  pressAccount,
  expectSignedInDecision,
  chooseSignedIn,
  setEnabledActionDetails,
} from "./provider-profile-add-flow-sign-in-outcomes-test-support";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_PROFILE_ACCENT_COLORS } from "@traycer/protocol/host/provider-schemas";

describe("Add a profile around one sign-in", () => {
  it("titles the dialog Add a profile and offers Sign in when the list offers sign-ins", async () => {
    renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", { name: "Add a profile" }),
    ).toBeTruthy();
    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn.textContent).toContain("Sign in");
    expect(
      screen.queryByRole("heading", { name: "Add new Claude Code profile" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
  });

  it("keeps today's title and Link account when offersSignIns is false", async () => {
    renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: false,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    const link = screen.getByRole("button", { name: "Link account" });
    expect(link.textContent).toContain("Link account");
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("keeps today's title and Link account when offersSignIns is absent", async () => {
    renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: "absent",
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    const link = screen.getByRole("button", { name: "Link account" });
    expect(link.textContent).toContain("Link account");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("keeps today's Add dialog on a computer negotiating providers.list 10.11", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: "10.11",
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link account" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    await waitFor(() => {
      expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    });
    const start = harness.calls.find(
      (call) => call.method === "providers.startLogin",
    );
    expect(start?.params).toMatchObject({
      profileId: null,
      createProfile: { label: "New profile" },
    });
    expect(start?.params).toHaveProperty("target", null);
  });

  it.each([true, "10.11"] as const)(
    "does not submit a pasted code again when Enter follows with offersSignIns %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        codePaste: true,
        holdStart: true,
        holdAwait: true,
      });
      await pressAccount(offers);
      expect(screen.queryByLabelText("Paste the code")).toBeNull();
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.startLogin"),
        ).toBe(1);
      });
      await act(async () => {
        harness.releaseStart();
        await Promise.resolve();
      });
      const input = await screen.findByLabelText("Paste the code");
      fireEvent.paste(input, {
        clipboardData: { getData: () => "abcd#1234" },
      });
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.submitLoginCode"),
        ).toBe(1);
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(
        methodCount(harness.messenger.calls, "providers.submitLoginCode"),
      ).toBe(1);
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );

  it.each([true, "10.11"] as const)(
    "copies the active sign-in link from the real Add dialog with offersSignIns %s",
    async (offers) => {
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(
        navigator,
        "clipboard",
      );
      const writeText = vi.fn((_value: string) => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      try {
        const harness = renderAddFlow({
          ...ADD_FLOW_DEFAULTS,
          offers,
          profilesBefore: [],
          profilesAfter: [],
          outcome: null,
          holdAwait: true,
        });
        await pressAccount(offers);
        const copyButton = await screen.findByRole("button", {
          name: /Copy sign-in link/,
        });
        await act(async () => {
          fireEvent.click(copyButton);
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith("https://example.test/sign-in");
        expect(
          methodCount(harness.messenger.calls, "providers.startLogin"),
        ).toBe(1);
      } finally {
        if (clipboardDescriptor === undefined) {
          Reflect.deleteProperty(navigator, "clipboard");
        } else {
          Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
        }
      }
    },
  );

  it.each([true, "10.11"] as const)(
    "opens the active sign-in link from the real Add dialog with offersSignIns %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        codePaste: true,
        holdAwait: true,
      });
      await pressAccount(offers);
      const openButton = await screen.findByRole("button", {
        name: /Open browser/,
      });
      expect(screen.getByText("Didn't return automatically?")).toBeTruthy();
      expect(openLinkMock).toHaveBeenCalledWith(
        "https://example.test/sign-in",
        "auth",
        null,
      );
      const callsBeforeClick = openLinkMock.mock.calls.length;
      fireEvent.click(openButton);
      expect(openLinkMock).toHaveBeenCalledTimes(callsBeforeClick + 1);
      expect(openLinkMock).toHaveBeenLastCalledWith(
        "https://example.test/sign-in",
        "auth",
        null,
      );
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
    },
  );

  it.each([true, "10.11"] as const)(
    "cancels an in-progress sign-in through providers.cancelLogin with offersSignIns %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        codePaste: true,
        submitOutcome: "noActiveLogin",
        holdAwait: true,
      });
      await pressAccount(offers);
      const input = await screen.findByLabelText("Paste the code");
      fireEvent.paste(input, {
        clipboardData: { getData: () => "abcd#1234" },
      });
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.submitLoginCode"),
        ).toBe(1);
      });
      expect(
        await screen.findByRole("button", { name: "Cancel sign-in" }),
      ).toHaveProperty("disabled", false);
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.cancelLogin"),
        ).toBe(1);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("names the signed-in profile that the list already has, then chooses it", async () => {
    const row = workProfile();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [row],
      profilesAfter: [row],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    await chooseSignedIn(harness, decisionReads);
  });

  it("names a signed-in profile that arrives on the re-read", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      seedCache: true,
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    await chooseSignedIn(harness, decisionReads);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
  });

  it("reads providers.list once when the signed-in profile already has the chosen accent", async () => {
    const row: ProviderProfile = {
      ...workProfile(),
      accentColor: "#ef4444",
    };
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [row],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      seedCache: true,
    });
    await pressAccount(true);
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(
      0,
    );
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
  });

  it("says signed in when the profile color save fails after sign-in", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      seedCache: true,
      failRecolor: true,
    });
    await pressAccount(true);

    expect(
      await screen.findByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "The account was linked, but the profile color could not be saved.",
      ),
    ).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      1,
    );
    expect(harness.created).not.toHaveBeenCalled();
  });

  it("says signed in when the profile color save fails after naming", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture("accepted");
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [existing, created],
      seedCache: true,
      failRecolor: true,
      authService: auth.service,
      recordEnvironment: true,
    });
    profileNameTransport.onAccepted = (name) =>
      harness.updateProfileName(MINTED_PROFILE_ID, name);
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    const pickedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
    expect(pickedColor).not.toBe(created.accentColor);
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "The account was linked, but the profile color could not be saved.",
      ),
    ).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      1,
    );
    expect(
      harness.calls
        .filter((call) => call.method === "providers.setEnabled")
        .map((call) => setEnabledActionDetails(call.params)),
    ).toEqual([{ label: null, accentColor: pickedColor }]);
    expect(auth.requests).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
      },
    ]);
    expect(harness.created).not.toHaveBeenCalled();
  });
});
