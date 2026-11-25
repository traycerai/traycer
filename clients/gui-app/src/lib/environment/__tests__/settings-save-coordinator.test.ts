import "../../../../__tests__/test-browser-apis";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import type {
  EnvironmentCloud,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentProposalsResponse } from "@traycer/protocol/host/environment/settings-proposals";
import type { SettingsSaveMapping } from "@traycer/protocol/host/environment/settings-save-mapping";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingValueDigest } from "@traycer-clients/shared/environment/environment-review";
import {
  createSettingsSaveCoordinator,
  type SettingsSaveContext,
  type SettingsSaveCoordinator,
  type SettingsSaveTicket,
} from "@/lib/environment/settings-save-coordinator";
import { settingsSaveMemoryKey } from "@/lib/persist";
import { SettingsSaveMemoryPersistLifecycleBridge } from "@/providers/settings-save-memory-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useSettingsSaveMemoryStore,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";

const ACCOUNT_ID = "account-a";
const ENVIRONMENT_ID = "environment-a";
const HOST_ID = "host-a";
const SHARING_GENERATION = 3;
const KEY = "memory";
const KIND = "agent_memory";
type BoundSave = Extract<SettingsSaveMemoryRecord, { environmentId: string }>;

type Value = { readonly enabled: boolean };

const noFollowUp = (): (() => void) => () => undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mappingAtKey(value: Value, key: string): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: KIND,
      key,
      os: null,
      operation: "put",
      value,
      canonicalValue: JSON.stringify(value),
    },
  };
}

function mapping(value: Value): SettingsSaveMapping {
  return mappingAtKey(value, KEY);
}

const context: SettingsSaveContext = {
  accountId: ACCOUNT_ID,
  environmentId: ENVIRONMENT_ID,
  hostId: HOST_ID,
  sharingGeneration: SHARING_GENERATION,
  expectedLiveRevision: 7,
};

function proposals() {
  return {
    proposals: [
      {
        proposal: {
          proposalId: "proposal-" + KEY,
          environmentId: ENVIRONMENT_ID,
          hostId: HOST_ID,
          sharingGeneration: SHARING_GENERATION,
          kind: KIND,
          key: KEY,
          os: null,
          operation: "put",
          state: "proposed",
        },
        localOverride: false,
        deliveredRevision: 7,
      },
    ],
  } satisfies EnvironmentProposalsResponse;
}

function promotedProposals(saveId: string): EnvironmentProposalsResponse {
  return {
    localSaveIds: [],
    proposals: [
      {
        proposal: {
          proposalId: saveId,
          environmentId: ENVIRONMENT_ID,
          hostId: HOST_ID,
          sharingGeneration: SHARING_GENERATION,
          kind: KIND,
          key: KEY,
          os: null,
          operation: "put",
          state: "proposed",
        },
        localOverride: true,
        deliveredRevision: null,
        promotion: { saveId, heldRevision: 9, moveWrittenRevision: null },
      },
    ],
  };
}

function review(value: Value): EnvironmentTransportAnswer {
  return {
    status: 200,
    text: JSON.stringify({
      review: {
        hosts: [],
        needsYou: [
          {
            type: "held",
            heldId: "held-a",
            revision: 2,
            kind: KIND,
            key: KEY,
            os: null,
            hostId: HOST_ID,
            sharingGeneration: SHARING_GENERATION,
            hostName: "Host",
            heldAt: 100,
            live: null,
            op: "put",
            value,
          },
        ],
      },
    }),
  };
}

function makeCloud(
  send: (
    request: EnvironmentTransportRequest,
  ) => Promise<EnvironmentTransportAnswer>,
): EnvironmentCloud {
  return {
    authnBaseUrl: "https://authn.example/",
    bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
    transport: send,
    onOriginSignIn: () => true,
  };
}

function isBoundSave(record: SettingsSaveMemoryRecord): record is BoundSave {
  return typeof record.environmentId === "string";
}

function currentRecord(): BoundSave | null {
  return (
    Object.values(useSettingsSaveMemoryStore.getState().records).find(
      (record): record is BoundSave =>
        isBoundSave(record) &&
        record.environmentId === ENVIRONMENT_ID &&
        record.hostId === HOST_ID &&
        record.sharingGeneration === SHARING_GENERATION &&
        record.kind === KIND &&
        record.key === KEY &&
        record.os === null,
    ) ?? null
  );
}

function setSignedInAccount(userId: string): void {
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
  });
}

async function beginTicket(
  coordinator: SettingsSaveCoordinator,
  value: Value,
): Promise<SettingsSaveTicket> {
  const beginning = await coordinator.begin(
    mapping(value),
    context,
    () => undefined,
  );
  if (beginning.kind !== "remembered") {
    throw new Error(`Expected a remembered save, got ${beginning.kind}`);
  }
  return beginning.ticket;
}

beforeEach(() => {
  window.localStorage.clear();
  useSettingsSaveMemoryStore.persist.setOptions({
    name: settingsSaveMemoryKey(null),
  });
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  setSignedInAccount(ACCOUNT_ID);
  render(
    createElement(SettingsSaveMemoryPersistLifecycleBridge, {
      children: createElement("div"),
    }),
  );
  if (
    useSettingsSaveMemoryStore.persist.getOptions().name !==
    settingsSaveMemoryKey(ACCOUNT_ID)
  ) {
    throw new Error("Expected the signed-in account's save memory");
  }
});

afterEach(() => {
  cleanup();
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  window.localStorage.clear();
});

describe("settings save edit fence", () => {
  it.each([
    ["the saved name", "Computer name"],
    ["a newer independent name", "Newer name"],
  ])(
    "does not resend a name after a lost reply when the record has %s",
    async (_outcome, currentAfterLoss) => {
      let currentName = "Original name";
      const sent: string[] = [];
      const readNames: string[] = [];
      let saveId = "";
      const receipt = () => ({
        saveId,
        environmentId: ENVIRONMENT_ID,
        providerId: "claude-code",
        profileId: "profile-a",
        name: "Computer name",
        baseName: "Original name",
      });
      const ports = {
        accountId: () => ACCOUNT_ID,
        cloud: () =>
          makeCloud(() => Promise.resolve({ status: 200, text: "" })),
        readProposals: () =>
          Promise.resolve({
            proposals: [],
            localSaveIds: [saveId],
            pendingProfileNames: [receipt()],
          }),
        profileNames: {
          read: () => {
            readNames.push(currentName);
            return Promise.resolve(currentName);
          },
          write: ({ name }: { readonly name: string }) => {
            sent.push(name);
            currentName = name;
            return Promise.reject(new Error("reply lost"));
          },
        },
        now: () => 100,
        schedule: noFollowUp,
      };
      const first = createSettingsSaveCoordinator(ports);
      const beginning = await first.beginLocal(
        { accountId: ACCOUNT_ID, hostId: HOST_ID, onOriginSignIn: () => true },
        () => Promise.resolve({ environmentId: ENVIRONMENT_ID, item: null }),
      );
      if (beginning.kind !== "remembered") throw new Error(beginning.kind);
      saveId = beginning.ticket.id;
      await first.settle(beginning.ticket, true);
      expect(readNames).toEqual(["Original name"]);
      expect(sent).toEqual(["Computer name"]);
      expect(
        useSettingsSaveMemoryStore.getState().records[saveId],
      ).toBeDefined();

      first.stop();
      currentName = currentAfterLoss;
      const second = createSettingsSaveCoordinator(ports);
      await second.reconcile(HOST_ID);
      await second.reconcile(HOST_ID);

      expect(readNames).toEqual(["Original name", currentAfterLoss]);
      expect(sent).toEqual(["Computer name"]);
      expect(currentName).toBe(currentAfterLoss);
      expect(useSettingsSaveMemoryStore.getState().records).toEqual({});
    },
  );

  it("leaves a hold for a legacy prebind record without a captured base in review", async () => {
    const saveId = useSettingsSaveMemoryStore.getState().remember({
      editId: "promoted-save",
      hostId: HOST_ID,
      writtenAt: 100,
      unanswered: null,
      environmentId: null,
    });

    const sent: EnvironmentTransportRequest[] = [];
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () =>
        makeCloud((request) => {
          sent.push(request);
          return Promise.resolve(review({ enabled: true }));
        }),
      readProposals: () => Promise.resolve(promotedProposals(saveId)),
      now: () => 100,
      schedule: noFollowUp,
    });

    await coordinator.reconcile(HOST_ID);

    expect(sent).toEqual([]);
  });

  it.each(["Stop", "sign-out"])(
    "leaves a prebind hold pending when %s overtakes its Personal binding read",
    async (reason) => {
      let onOrigin = true;
      let saveId = "";
      const bindingRead = deferred<void>();
      const bindingReply = deferred<EnvironmentTransportAnswer>();
      const sent: EnvironmentTransportRequest[] = [];
      const coordinator = createSettingsSaveCoordinator({
        accountId: () => ACCOUNT_ID,
        cloud: () => ({
          ...makeCloud((request) => {
            sent.push(request);
            if (request.url.endsWith("/hosts?include=binding")) {
              bindingRead.resolve(undefined);
              return bindingReply.promise;
            }
            return Promise.resolve(review({ enabled: true }));
          }),
          onOriginSignIn: () => onOrigin,
        }),
        readProposals: () => Promise.resolve(promotedProposals(saveId)),
        now: () => 100,
        schedule: noFollowUp,
      });
      const change = mapping({ enabled: true });
      if (change.kind !== "proposal") throw new Error("Expected an item edit");
      const beginning = await coordinator.beginLocal(
        {
          accountId: ACCOUNT_ID,
          hostId: HOST_ID,
          onOriginSignIn: () => onOrigin,
        },
        () =>
          Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            item: { edit: change.edit, expectedLiveRevision: 7 },
          }),
      );
      if (beginning.kind !== "remembered") throw new Error(beginning.kind);
      saveId = beginning.ticket.id;

      const reconciling = coordinator.reconcile(HOST_ID);
      await bindingRead.promise;
      if (reason === "Stop") coordinator.stop();
      else onOrigin = false;
      bindingReply.resolve({
        status: 200,
        text: JSON.stringify({
          hosts: [{ hostId: HOST_ID, sharingGeneration: SHARING_GENERATION }],
        }),
      });
      await reconciling;

      expect(sent).toHaveLength(1);
      expect(
        useSettingsSaveMemoryStore.getState().records[saveId],
      ).toBeDefined();
    },
  );

  it("does not apply A's proposal after B replaces A during the proposals read", async () => {
    const reading = deferred<void>();
    const proposalsAnswer = deferred<EnvironmentProposalsResponse>();
    const sent: EnvironmentTransportRequest[] = [];
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () =>
        makeCloud((request) => {
          sent.push(request);
          if (request.method === "GET") {
            return Promise.resolve(review({ enabled: false }));
          }
          return Promise.resolve({ status: 200, text: "" });
        }),
      readProposals: async () => {
        reading.resolve(undefined);
        return proposalsAnswer.promise;
      },
      now: () => 100,
      schedule: noFollowUp,
    });

    await beginTicket(coordinator, { enabled: false });
    const reconciling = coordinator.reconcile(HOST_ID);
    await reading.promise;
    await beginTicket(coordinator, { enabled: true });
    proposalsAnswer.resolve(proposals());
    await reconciling;

    expect(sent.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(currentRecord()?.valueDigest).toBe(
      await settingValueDigest({ enabled: true }),
    );
  });

  it("does not apply A's proposal after B replaces A during the holds read", async () => {
    const reading = deferred<void>();
    const holdsAnswer = deferred<EnvironmentTransportAnswer>();
    const sent: EnvironmentTransportRequest[] = [];
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () =>
        makeCloud(async (request) => {
          sent.push(request);
          if (request.method === "GET") {
            reading.resolve(undefined);
            return holdsAnswer.promise;
          }
          return { status: 200, text: "" };
        }),
      readProposals: () => Promise.resolve(proposals()),
      now: () => 100,
      schedule: noFollowUp,
    });

    await beginTicket(coordinator, { enabled: false });
    const reconciling = coordinator.reconcile(HOST_ID);
    await reading.promise;
    await beginTicket(coordinator, { enabled: true });
    holdsAnswer.resolve(review({ enabled: false }));
    await reconciling;

    expect(sent.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(currentRecord()?.valueDigest).toBe(
      await settingValueDigest({ enabled: true }),
    );
  });

  it("keeps B when A's apply answers", async () => {
    const applying = deferred<void>();
    const applyAnswer = deferred<EnvironmentTransportAnswer>();
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () =>
        makeCloud(async (request) => {
          if (request.method === "GET") return review({ enabled: false });
          applying.resolve(undefined);
          return applyAnswer.promise;
        }),
      readProposals: () => Promise.resolve(proposals()),
      now: () => 100,
      schedule: noFollowUp,
    });

    await beginTicket(coordinator, { enabled: false });
    const reconciling = coordinator.reconcile(HOST_ID);
    await applying.promise;
    await beginTicket(coordinator, { enabled: true });
    applyAnswer.resolve({ status: 200, text: "" });
    await reconciling;

    expect(currentRecord()?.valueDigest).toBe(
      await settingValueDigest({ enabled: true }),
    );
  });

  it("continues after A's unanswered apply when B replaced its row", async () => {
    const otherKey = "memory-other";
    const applyStarted = deferred<void>();
    const applyAnswer = deferred<EnvironmentTransportAnswer>();
    const proposalsForBoth: EnvironmentProposalsResponse = {
      proposals: [
        ...proposals().proposals,
        {
          proposal: {
            proposalId: "proposal-" + otherKey,
            environmentId: ENVIRONMENT_ID,
            hostId: HOST_ID,
            sharingGeneration: SHARING_GENERATION,
            kind: KIND,
            key: otherKey,
            os: null,
            operation: "put",
            state: "proposed",
          },
          localOverride: false,
          deliveredRevision: 7,
        },
      ],
    };
    const reviewForBoth: EnvironmentTransportAnswer = {
      status: 200,
      text: JSON.stringify({
        review: {
          hosts: [],
          needsYou: [
            {
              type: "held",
              heldId: "held-a",
              revision: 2,
              kind: KIND,
              key: KEY,
              os: null,
              hostId: HOST_ID,
              sharingGeneration: SHARING_GENERATION,
              hostName: "Host",
              heldAt: 100,
              live: null,
              op: "put",
              value: { enabled: false },
            },
            {
              type: "held",
              heldId: "held-c",
              revision: 3,
              kind: KIND,
              key: otherKey,
              os: null,
              hostId: HOST_ID,
              sharingGeneration: SHARING_GENERATION,
              hostName: "Host",
              heldAt: 100,
              live: null,
              op: "put",
              value: { enabled: true },
            },
          ],
        },
      }),
    };
    let applyCount = 0;
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () =>
        makeCloud(async (request) => {
          if (request.method === "GET") return reviewForBoth;
          applyCount += 1;
          if (applyCount === 1) {
            applyStarted.resolve(undefined);
            return applyAnswer.promise;
          }
          return { status: 200, text: "" };
        }),
      readProposals: () => Promise.resolve(proposalsForBoth),
      now: () => 100,
      schedule: noFollowUp,
    });

    await beginTicket(coordinator, { enabled: false });
    const otherBeginning = await coordinator.begin(
      mappingAtKey({ enabled: true }, otherKey),
      context,
      () => undefined,
    );
    expect(otherBeginning.kind).toBe("remembered");

    const reconciling = coordinator.reconcile(HOST_ID);
    await applyStarted.promise;
    await beginTicket(coordinator, { enabled: true });
    applyAnswer.reject(new Error("no answer"));
    await reconciling;

    expect(applyCount).toBe(2);
    expect(currentRecord()?.unanswered).toBeNull();
    expect(
      Object.values(useSettingsSaveMemoryStore.getState().records).some(
        (record) => record.environmentId !== null && record.key === otherKey,
      ),
    ).toBe(false);
  });

  it("keeps B when A's unlisted proposal is forgotten after its grace", async () => {
    let now = 0;
    const reading = deferred<void>();
    const proposalsAnswer = deferred<EnvironmentProposalsResponse>();
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () => makeCloud(() => Promise.resolve({ status: 200, text: "" })),
      readProposals: async () => {
        reading.resolve();
        return proposalsAnswer.promise;
      },
      now: () => now,
      schedule: noFollowUp,
    });

    const original = await beginTicket(coordinator, { enabled: false });
    await coordinator.settle(original, false);
    now = 60_001;
    const reconciling = coordinator.reconcile(HOST_ID);
    await reading.promise;
    const replacement = await beginTicket(coordinator, { enabled: true });
    await coordinator.settle(replacement, false);
    proposalsAnswer.resolve({ proposals: [] });
    await reconciling;

    expect(currentRecord()?.valueDigest).toBe(
      await settingValueDigest({ enabled: true }),
    );
  });

  it("reads proposals after a save answer without using a save receipt", async () => {
    const reads: string[] = [];
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT_ID,
      cloud: () => makeCloud(() => Promise.resolve({ status: 200, text: "" })),
      readProposals: (hostId) => {
        reads.push(hostId);
        return Promise.resolve({ proposals: [] });
      },
      now: () => 100,
      schedule: noFollowUp,
    });

    const ticket = await beginTicket(coordinator, { enabled: true });
    await coordinator.settle(ticket, true);

    expect(reads).toEqual([HOST_ID]);
  });

  it("persists a second edit at an address after its earlier row was forgotten", async () => {
    const name = settingsSaveMemoryKey(ACCOUNT_ID);
    useSettingsSaveMemoryStore.persist.setOptions({ name });
    useSettingsSaveMemoryStore.persist.clearStorage();
    await useSettingsSaveMemoryStore.persist.rehydrate();
    const record = {
      editId: "edit-a",
      environmentId: ENVIRONMENT_ID,
      hostId: HOST_ID,
      sharingGeneration: SHARING_GENERATION,
      kind: KIND,
      key: KEY,
      os: null,
      operation: "put" as const,
      valueDigest: "digest-a",
      expectedLiveRevision: 7,
      writtenAt: 100,
      unanswered: null,
    };

    const firstId = useSettingsSaveMemoryStore.getState().remember(record);
    useSettingsSaveMemoryStore.getState().forget(firstId);
    useSettingsSaveMemoryStore.getState().remember({
      ...record,
      editId: "edit-b",
      valueDigest: "digest-b",
    });
    await useSettingsSaveMemoryStore.persist.rehydrate();

    expect(
      Object.values(useSettingsSaveMemoryStore.getState().records),
    ).toEqual([
      expect.objectContaining({ editId: "edit-b", valueDigest: "digest-b" }),
    ]);
  });
});
