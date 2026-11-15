import {
  PROFILE_ID,
  MINTED_PROFILE_ID,
  DID_NOT_FINISH,
  WAITING,
  UNREADABLE,
  SIGNED_IN,
  ALREADY_SIGNED_IN,
  LIST_KEY,
  type ListResponse,
  ADD_FLOW_DEFAULTS,
  workProfile,
  createAddProfileNameAuthFixture,
  projectedWorkProfile,
  listBody,
  renderAddFlow,
  methodCount,
  startCreateProfile,
  pressAccount,
  expectSignedInDecision,
  chooseSignedIn,
  expectAddDidNotFinish,
  mintedSignedInRow,
  ADD_MISFITS,
} from "./provider-profile-add-flow-sign-in-outcomes-test-support";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Add a profile around one sign-in", () => {
  it("waits, with Done, when the signed-in id is still absent after one re-read", async () => {
    const auth = await createAddProfileNameAuthFixture("forbidden");
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      authService: auth.service,
    });
    await pressAccount(true);
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(harness.created).not.toHaveBeenCalled();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      0,
    );
    expect(auth.requests).toEqual([]);
  });

  it.each([true, "10.11"] as const)(
    "shows the existing account without recoloring it when offersSignIns is %s",
    async (offers) => {
      const row = workProfile();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [row],
        profilesAfter: [row],
        outcome:
          offers === true
            ? { kind: "already-signed-in", profileId: PROFILE_ID }
            : null,
        echoedProfiles: [row],
        echoedExistingProfileId: PROFILE_ID,
      });
      await pressAccount(offers);
      if (offers === true) {
        expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
        expect(
          screen.getByLabelText("Profile name").hasAttribute("disabled"),
        ).toBe(true);
        expect(
          screen.queryByRole("button", { name: "Save profile" }),
        ).toBeNull();
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
        fireEvent.click(screen.getByRole("button", { name: "Use" }));
        await waitFor(() => {
          expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
      } else {
        expect(await screen.findByText("Account already linked")).toBeTruthy();
        expect(screen.queryByText(ALREADY_SIGNED_IN)).toBeNull();
        expect(harness.created).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => {
          expect(
            methodCount(harness.messenger.calls, "providers.startLogin"),
          ).toBe(2);
        });
        const retries = harness.calls.filter(
          (call) => call.method === "providers.startLogin",
        );
        expect(retries).toHaveLength(2);
        const retry = retries[1];
        expect(retry.params).toMatchObject({
          providerId: "claude-code",
          profileId: null,
          target: null,
        });
        expect(startCreateProfile(retry.params)).toEqual({
          label: "New profile",
          shareSkillsAndPlugins: true,
        });
      }
    },
  );

  it("starts another sign-in at once from an account that already has a profile", async () => {
    const row = workProfile();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [row],
      profilesAfter: [row],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with another" }),
    );
    await waitFor(() => {
      expect(methodCount(harness.calls, "providers.startLogin")).toBe(2);
    });
    const second = harness.calls.filter(
      (call) => call.method === "providers.startLogin",
    )[1];
    expect(startCreateProfile(second.params)).toEqual({
      label: "New profile",
      shareSkillsAndPlugins: true,
    });
    expect(harness.created).not.toHaveBeenCalled();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
  });

  it("waits when an already-signed-in id is absent after the re-read", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screen.queryByText(ALREADY_SIGNED_IN)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(harness.created).not.toHaveBeenCalled();
  });

  it.each(["Done", "Close", "Escape"] as const)(
    "closing a waiting-for-profile footer by %s sends no cancelLogin",
    async (how) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome: { kind: "waiting-for-profile" },
      });
      await pressAccount(true);
      expect(await screen.findByText(WAITING)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      if (how === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else {
        fireEvent.click(screen.getByRole("button", { name: how }));
      }
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(methodCount(harness.calls, "providers.cancelLogin")).toBe(0);
      expect(harness.created).not.toHaveBeenCalled();
    },
  );

  it.each(ADD_MISFITS)(
    "ends $label on today's unfinished sign-in when the old keys are empty",
    async ({ outcome }) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome,
        ownership: true,
      });
      await pressAccount(true);
      await expectAddDidNotFinish(harness);
    },
  );

  it.each(ADD_MISFITS)(
    "ends $label on today's unfinished sign-in when the old keys say signed in",
    async ({ outcome }) => {
      const signedIn = mintedSignedInRow();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome,
        echoedProfiles: [signedIn],
        ownership: true,
      });
      await pressAccount(true);
      await expectAddDidNotFinish(harness);
    },
  );

  it("names a signed-in profile from the answer's own rows when the re-read does not", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      echoedProfiles: [workProfile()],
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [], false),
    );
    await chooseSignedIn(harness, decisionReads);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [], false),
    );
  });

  it("does not offer naming for an already-signed-in profile from the answer's own rows", async () => {
    const auth = await createAddProfileNameAuthFixture("forbidden");
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
      echoedProfiles: [workProfile()],
      authService: auth.service,
    });
    await pressAccount(true);
    expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    expect(harness.listsAfterAwait()).toBe(1);
    expect(harness.created).not.toHaveBeenCalled();
    expect(auth.requests).toEqual([]);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [], false),
    );
  });

  it("names the profile after Retry when the re-read failed and then lists it", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      listFailuresAfterAwait: 1,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(2);
    await chooseSignedIn(harness, decisionReads);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(harness.listsAfterAwait()).toBe(3);
  });

  it("waits after Retry when the re-read failed and then still lacks the profile", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      listFailuresAfterAwait: 1,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(harness.listsAfterAwait()).toBe(2);
    expect(harness.created).not.toHaveBeenCalled();
  });

  it("keeps the unreadable footer when Retry cannot read the list", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      listFailuresAfterAwait: 3,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    const startsBeforeRetry = methodCount(
      harness.calls,
      "providers.startLogin",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(harness.listsAfterAwait()).toBe(2);
    });
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(
      startsBeforeRetry,
    );
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(harness.listsAfterAwait()).toBe(3);
    });
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(
      startsBeforeRetry,
    );
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(harness.created).not.toHaveBeenCalled();
  });

  it.each(["Close", "Escape"] as const)(
    "closing a list-unread footer by %s sends no cancelLogin",
    async (how) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome: { kind: "signed-in", profileId: PROFILE_ID },
        listFailuresAfterAwait: 2,
      });
      await pressAccount(true);
      expect(await screen.findByText(UNREADABLE)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
      expect(screen.queryByText(WAITING)).toBeNull();
      expect(screen.queryByText(SIGNED_IN)).toBeNull();
      if (how === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else {
        fireEvent.click(screen.getByRole("button", { name: how }));
      }
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(methodCount(harness.calls, "providers.cancelLogin")).toBe(0);
      expect(harness.created).not.toHaveBeenCalled();
    },
  );

  it("reads no providers.list when Add a profile opens over a fresh cache", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
      seedCache: true,
    });
    expect(
      await screen.findByRole("heading", { name: "Add a profile" }),
    ).toBeTruthy();
    expect(harness.listCalls()).toBe(0);
  });

  it("reads no providers.list when today's Add dialog opens over a fresh cache", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: false,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
      seedCache: true,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    expect(harness.listCalls()).toBe(0);
  });

  it("refetches providers.list once when a sign-in answer carries state", async () => {
    const row = workProfile();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [row],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      echoedProfiles: [row],
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [row], false),
    );
    await chooseSignedIn(harness, decisionReads);
  });

  it("keeps offersSignIns after a signed-in echo misses the row and its refresh fails", async () => {
    const projected = projectedWorkProfile();
    const removedProfiles = [
      {
        providerId: "claude-code",
        profileId: "removed-work",
        aliases: ["old-work"],
      },
    ];
    const cacheSeed = {
      ...listBody(true, [projected], false),
      removedProfiles,
      futureKey: "kept",
    };
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [projected],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [],
      listFailuresAfterAwait: 1,
      seedCache: true,
      cacheSeed,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add a profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
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
    const cached = harness.queryClient.getQueryData<
      ListResponse & { readonly futureKey: string }
    >(LIST_KEY);
    if (cached === undefined)
      throw new Error("The provider list cache is missing");
    expect(cached.offersSignIns).toBe(true);
    expect(cached.removedProfiles).toEqual(removedProfiles);
    expect(cached.futureKey).toBe("kept");
  });
});
