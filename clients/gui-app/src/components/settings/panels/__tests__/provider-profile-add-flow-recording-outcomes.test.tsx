import {
  PROFILE_ID,
  DID_NOT_FINISH,
  WAITING,
  SIGNED_IN,
  ALREADY_SIGNED_IN,
  LIST_KEY,
  type ListResponse,
  ADD_FLOW_DEFAULTS,
  workProfile,
  createAddProfileNameAuthFixture,
  projectedWorkProfile,
  listBody,
  nothingChanged,
  asksToRecordSignIn,
  renderAddFlow,
  signInFetchFor,
  methodCount,
  pressAccount,
  expectNoSuccessSentence,
} from "./provider-profile-add-flow-sign-in-outcomes-test-support";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProviderLoginProfileOutcome } from "@traycer/protocol/host/provider-schemas";
import {
  ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY,
  FORBIDDEN_SIGN_IN_REQUEST_REPLY,
  MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
  noAnswerReply,
  RECORDED_SIGN_IN_REQUEST_REPLY,
  SIGN_IN_REQUEST_FIXTURE,
  UNAUTHORIZED_SIGN_IN_REQUEST_REPLY,
  type SignInRequestFetchReply,
} from "@traycer-clients/shared/test-fixtures/provider-sign-in-request-test-support";

describe("Add a profile around one sign-in", () => {
  it("keeps unknown envelope and projection fields through the await overlay before its refresh settles", async () => {
    const projected = projectedWorkProfile();
    const auth = await createAddProfileNameAuthFixture("forbidden");
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
      profilesAfter: [projected],
      outcome: { kind: "waiting-for-profile" },
      echoedProfiles: [workProfile()],
      seedCache: true,
      cacheSeed,
      holdListRefresh: true,
      authService: auth.service,
    });
    await pressAccount(true);
    await waitFor(() => expect(harness.listsAfterAwait()).toBe(1));
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    expect(auth.requests).toEqual([]);
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
    expect(cached.providers[0]?.profiles[0]).toMatchObject({
      profileId: PROFILE_ID,
      aliases: ["legacy-work"],
      otherNames: ["Claude account"],
      personNotice: "waiting",
    });
    act(() => harness.releaseListRefresh());
    await waitFor(() => {
      expect(harness.queryClient.getQueryState(LIST_KEY)?.fetchStatus).toBe(
        "idle",
      );
    });
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
  });

  it("keeps today's result for an older computer without a sign-in request", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [workProfile()],
      profilesAfter: [workProfile()],
      outcome: null,
    });
    await pressAccount(true);
    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expectNoSuccessSentence();
    expect(harness.created).not.toHaveBeenCalled();
    expect(signInFetchFor(harness).fetchMock).not.toHaveBeenCalled();
    const awaitRequests = harness.messenger.calls
      .filter((call) => call.method === "providers.awaitLogin")
      .map((call) => call.params);
    expect(awaitRequests).toHaveLength(1);
    expect(awaitRequests[0]).not.toHaveProperty("recordedOperationId");
  });

  it("records the request and asks again with its id before showing the signed-in profile", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: null,
      awaitAnswers: [
        asksToRecordSignIn(),
        nothingChanged({ kind: "signed-in", profileId: PROFILE_ID }),
      ],
    });
    signInFetchFor(harness).enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    await pressAccount(true);

    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    const awaitRequests = harness.messenger.calls
      .filter((call) => call.method === "providers.awaitLogin")
      .map((call) => call.params);
    expect(awaitRequests).toHaveLength(2);
    expect(awaitRequests[1]).toMatchObject({
      recordedOperationId: SIGN_IN_REQUEST_FIXTURE.operationId,
    });
    expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "a 403", reply: FORBIDDEN_SIGN_IN_REQUEST_REPLY },
    { name: "a 404", reply: ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY },
    { name: "no answer", reply: noAnswerReply() },
    { name: "a 401", reply: UNAUTHORIZED_SIGN_IN_REQUEST_REPLY },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly reply: SignInRequestFetchReply;
  }>)(
    "shows the existing did-not-finish result after recording ends on $name",
    async ({ reply }) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        awaitAnswers: [asksToRecordSignIn()],
      });
      signInFetchFor(harness).enqueue(reply);
      await pressAccount(true);

      expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      expect(
        harness.messenger.calls.filter(
          (call) => call.method === "providers.awaitLogin",
        ),
      ).toHaveLength(1);
      expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.created).not.toHaveBeenCalled();
    },
  );

  it("shows the did-not-finish result after a duplicate record answer", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: null,
      awaitAnswers: [
        asksToRecordSignIn(),
        nothingChanged({ kind: "signed-in", profileId: PROFILE_ID }),
      ],
    });
    signInFetchFor(harness).enqueue(
      MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
    );
    await pressAccount(true);

    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expectNoSuccessSentence();
    expect(harness.created).not.toHaveBeenCalled();
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toHaveLength(1);
    expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not record twice when the computer asks again for the recorded id", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
      awaitAnswers: [asksToRecordSignIn(), asksToRecordSignIn()],
    });
    signInFetchFor(harness).enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    await pressAccount(true);

    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toHaveLength(2);
    expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, "absent"] as const)(
    "ignores a signed-in outcome when offersSignIns is %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [workProfile()],
        profilesAfter: [workProfile()],
        outcome: { kind: "signed-in", profileId: PROFILE_ID },
      });
      await pressAccount(offers);
      expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      expect(screen.queryByText(SIGNED_IN)).toBeNull();
      expect(harness.created).not.toHaveBeenCalled();
      expect(harness.listCalls()).toBe(1);
      expect(harness.listsAfterAwait()).toBe(0);
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    },
  );

  it.each([true, false, "absent"] as const)(
    "renders the Add description according to offersSignIns (%s)",
    async (offers) => {
      renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
      });
      await screen.findByRole("dialog");
      const description =
        "Name this Claude Code profile, choose its color, then link the account it should use.";
      if (offers === true) {
        expect(screen.queryByText(description)).toBeNull();
        return;
      }
      expect(screen.getByText(description)).toBeTruthy();
    },
  );

  it.each([
    { label: "null", unknown: false },
    { label: "unknown", unknown: true },
  ] as const)(
    "keeps DuplicateAccountNotice and its Sign in again footer for an unreadable $label outcome",
    async ({ unknown }) => {
      const row = workProfile();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [row],
        profilesAfter: [row],
        outcome: null,
        echoedProfiles: [row],
        seedCache: true,
        unknownProfileOutcome: unknown,
      });
      await pressAccount(true);
      expect(await screen.findByText("Account already linked")).toBeTruthy();
      expect(
        screen.getByText(
          "Work already uses this account and organization. Sign in again and choose a different organization.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Sign in again" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    },
  );

  it.each([
    { label: "waiting-for-profile", outcome: { kind: "waiting-for-profile" } },
    { label: "account-mismatch", outcome: { kind: "account-mismatch" } },
    { label: "account-unproven", outcome: { kind: "account-unproven" } },
    {
      label: "target-refused",
      outcome: { kind: "target-refused", reason: "not-authorized" },
    },
    {
      label: "staged-for-leave",
      outcome: { kind: "staged-for-leave", profileId: PROFILE_ID },
    },
    {
      label: "signed-in",
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
    },
    {
      label: "already-signed-in",
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
    },
  ] as const satisfies ReadonlyArray<{
    readonly label: string;
    readonly outcome: ProviderLoginProfileOutcome;
  }>)(
    "does not show DuplicateAccountNotice for readable $label",
    async ({ outcome }) => {
      const row = workProfile();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [row],
        profilesAfter: [row],
        outcome,
        echoedProfiles: [row],
        seedCache: true,
      });
      await pressAccount(true);
      if (outcome.kind === "waiting-for-profile") {
        expect(await screen.findByText(WAITING)).toBeTruthy();
      } else if (outcome.kind === "signed-in") {
        expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
      } else if (outcome.kind === "already-signed-in") {
        expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
      } else {
        expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      }
      expect(screen.queryByText("Account already linked")).toBeNull();
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );
});
