import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  SandboxCreateRequest,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

type RowState = "destroyed" | "awake" | "failed";

interface RowAnswer {
  readonly state: RowState;
  readonly failureCode?: string;
}

interface HeldKey {
  readonly sandboxId: string;
  reservationRequest?: SandboxCreateRequest;
  readonly releases: Array<PromiseWithResolvers<void>>;
  readonly arrivals: Array<PromiseWithResolvers<void>>;
  row: RowAnswer | null;
  readonly seededSummary?: SandboxSummary;
  calls: number;
}

interface Unnamed402Plan {
  readonly qualifyingCreditGate: boolean;
  calls: number;
  transferredSandboxId: string | null;
}

interface Named402Plan {
  readonly sandbox: SandboxSummary;
  calls: number;
}

/** A control-plane fake: one row per idempotency key, with joiners sharing its answer. */
export function createSandboxRetryWalkFake(
  initialKey: string,
  environmentId: string | undefined,
): {
  readonly requests: SandboxCreateRequest[];
  readonly create: (
    request: SandboxCreateRequest,
  ) => Promise<SandboxCreateFetchResult>;
  readonly waitForArrival: (key: string, ordinal: number) => Promise<void>;
  readonly answer: (key: string, ordinal: number, row: RowAnswer) => void;
  readonly seedJoinedRow: (key: string, sandbox: SandboxSummary) => void;
  readonly refuseUnnamed402: (
    key: string,
    qualifyingCreditGate: boolean,
  ) => void;
  readonly refuseNamed402: (key: string, sandbox: SandboxSummary) => void;
} {
  const entries = new Map<string, HeldKey>();
  const unnamed402 = new Map<string, Unnamed402Plan>();
  const named402 = new Map<string, Named402Plan>();
  const requests: SandboxCreateRequest[] = [];

  const sandboxIdFor = (key: string): string => {
    if (key === initialKey) return "holder-1";
    const previousId = key.startsWith("retry:")
      ? key.slice("retry:".length)
      : "";
    const previousIndex = Number(previousId.replace("holder-", ""));
    return Number.isInteger(previousIndex) &&
      previousIndex >= 1 &&
      previousIndex < 5
      ? `holder-${previousIndex + 1}`
      : "final-holder";
  };

  return {
    requests,
    create: (request) => {
      const key = request.clientRequestId;
      if (key === null)
        throw new Error("the create request had no idempotency key");
      requests.push(request);
      const namedRefusal = named402.get(key);
      if (namedRefusal !== undefined) {
        namedRefusal.calls += 1;
        return Promise.resolve(
          namedRefusal.calls === 1
            ? namedCreditRefusal(namedRefusal.sandbox.id)
            : {
                kind: "ok",
                joined: true,
                accepted: {
                  sandboxId: namedRefusal.sandbox.id,
                  hostId: namedRefusal.sandbox.hostId,
                  sandbox: namedRefusal.sandbox,
                },
              },
        );
      }
      const refusal = unnamed402.get(key);
      if (refusal !== undefined) {
        refusal.calls += 1;
        if (refusal.calls === 1 || !refusal.qualifyingCreditGate)
          return Promise.resolve(unnamedCreditRefusal());
        if (refusal.transferredSandboxId === null) {
          refusal.transferredSandboxId = "credit-gate-transfer";
          return Promise.resolve(
            acceptedRow(refusal.transferredSandboxId, "awake", undefined),
          );
        }
        return Promise.resolve(
          acceptedRow(refusal.transferredSandboxId, "awake", true),
        );
      }
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {
          sandboxId: sandboxIdFor(key),
          reservationRequest: request,
          releases: [],
          arrivals: [],
          row: null,
          calls: 0,
        };
        entries.set(key, entry);
      }
      if (entry.reservationRequest === undefined)
        entry.reservationRequest = request;
      entry.calls += 1;
      while (entry.releases.length < entry.calls)
        entry.releases.push(Promise.withResolvers<void>());
      while (entry.arrivals.length < entry.calls)
        entry.arrivals.push(Promise.withResolvers<void>());
      const arrival = entry.arrivals[entry.calls - 1];
      arrival.resolve();
      if (entry.seededSummary !== undefined) {
        return Promise.resolve({
          kind: "ok",
          joined: true,
          accepted: {
            sandboxId: entry.seededSummary.id,
            hostId: entry.seededSummary.hostId,
            sandbox: entry.seededSummary,
          },
        });
      }
      const joined =
        entry.sandboxId === "final-holder" ? entry.calls > 1 : true;
      const release = entry.releases[entry.calls - 1];
      return release.promise.then((): SandboxCreateFetchResult => {
        const row = entry.row;
        if (row === null) throw new Error("the holder row was not recorded");
        return {
          kind: "ok",
          ...(joined ? { joined: true } : {}),
          accepted: {
            sandboxId: entry.sandboxId,
            hostId: `host-${entry.sandboxId}`,
            sandbox: sandboxSummaryFixture({
              id: entry.sandboxId,
              hostId: `host-${entry.sandboxId}`,
              state: row.state,
              ...(entry.reservationRequest === undefined
                ? {}
                : {
                    createdByTaskId: entry.reservationRequest.createdByTaskId,
                    displayName: entry.reservationRequest.displayName,
                  }),
              ...(environmentId === undefined ? {} : { environmentId }),
              ...(row.failureCode === undefined
                ? {}
                : { failureCode: row.failureCode }),
            }),
          },
        };
      });
    },
    waitForArrival: (key, ordinal) => {
      if (ordinal < 1) throw new Error("arrival numbers start at one");
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {
          sandboxId: sandboxIdFor(key),
          releases: [],
          arrivals: [],
          row: null,
          calls: 0,
        };
        entries.set(key, entry);
      }
      if (entry.calls >= ordinal) return Promise.resolve();
      while (entry.arrivals.length < ordinal)
        entry.arrivals.push(Promise.withResolvers<void>());
      const arrival = entry.arrivals[ordinal - 1];
      return arrival.promise;
    },
    answer: (key, ordinal, row) => {
      const entry = entries.get(key);
      if (entry === undefined)
        throw new Error("cannot answer a key before its request arrives");
      const release = entry.releases[ordinal - 1];
      entry.row = row;
      release.resolve();
    },
    seedJoinedRow: (key, sandbox) => {
      if (entries.has(key)) throw new Error("a key can only be seeded once");
      entries.set(key, {
        sandboxId: sandbox.id,
        releases: [],
        arrivals: [],
        row: null,
        seededSummary: sandbox,
        calls: 0,
      });
    },
    refuseUnnamed402: (key, qualifyingCreditGate) => {
      if (unnamed402.has(key))
        throw new Error("a refusal can only be seeded once");
      unnamed402.set(key, {
        qualifyingCreditGate,
        calls: 0,
        transferredSandboxId: null,
      });
    },
    refuseNamed402: (key, sandbox) => {
      if (named402.has(key))
        throw new Error("a named refusal can only be seeded once");
      named402.set(key, { sandbox, calls: 0 });
    },
  };
}

function unnamedCreditRefusal(): Extract<
  SandboxCreateFetchResult,
  { readonly kind: "refused" }
> {
  return {
    kind: "refused",
    status: 402,
    code: "insufficient_credit",
    reason: "denied",
    shortfallMc: 120,
    creditSource: "team",
    newRateMcPerHour: 120,
    currentAwakeBurnMcPerHour: 0,
    message: null,
  };
}

function namedCreditRefusal(
  sandboxId: string,
): Extract<SandboxCreateFetchResult, { readonly kind: "refused" }> {
  return {
    ...unnamedCreditRefusal(),
    sandboxId,
  };
}

function acceptedRow(
  sandboxId: string,
  state: RowState,
  joined: true | undefined,
): SandboxCreateFetchResult {
  const hostId = `host-${sandboxId}`;
  return {
    kind: "ok",
    ...(joined === undefined ? {} : { joined }),
    accepted: {
      sandboxId,
      hostId,
      sandbox: sandboxSummaryFixture({ id: sandboxId, hostId, state }),
    },
  };
}
