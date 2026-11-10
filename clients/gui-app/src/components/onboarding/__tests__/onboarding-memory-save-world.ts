/**
 * A model of the host the memory act's save talks to, small enough to explore
 * exhaustively. Two configurations (A and B), a host bound to one of them, and
 * the three ways a host can answer `config.agentMemories.set`. Nothing here
 * knows how the save keeps its evidence: that is whatever `io.record` was
 * given last, copied and keyed but never read.
 */
import type {
  ConfigAgentMemoriesResponse,
  ConfigAgentMemoriesSetResponse,
} from "@traycer/protocol/host/config/schemas";
import type { OnboardingMemoryRow } from "@/components/onboarding/onboarding-agent-memories-model";
import {
  NO_SAVE_EVIDENCE,
  runMemorySave,
  traycerStanding,
  type MemorySaveIo,
  type MemorySaveResult,
  type SaveEvidence,
  type UploadStatus,
} from "@/components/onboarding/onboarding-memory-save";

export type Env = "A" | "B";
export type SetMode = "applied" | "saved" | "queued";
type UploadState = "pending" | "refused" | "accepted";

interface Upload {
  readonly id: string;
  readonly env: Env;
  state: UploadState;
}
interface ConfigState {
  revision: number;
  value: boolean;
}
interface Receipt {
  readonly uploadId: string;
  readonly environmentId: Env;
  readonly revision: number;
}

export interface World {
  cfg: Record<Env, ConfigState>;
  received: Record<Env, ConfigState>;
  bound: Env;
  mode: SetMode;
  uploads: Upload[];
  receipts: Receipt[];
  /** A set of this act the configuration saved at once (applied or saved). */
  wrote: Record<Env, boolean>;
  nextId: number;
  providers: Record<"claude-code" | "codex", boolean>;
  failNext: boolean;
  evidence: SaveEvidence;
}

export function initialWorld(): World {
  return {
    cfg: { A: { revision: 1, value: false }, B: { revision: 1, value: false } },
    received: {
      A: { revision: 1, value: false },
      B: { revision: 1, value: false },
    },
    bound: "A",
    mode: "applied",
    uploads: [],
    receipts: [],
    wrote: { A: false, B: false },
    nextId: 1,
    providers: { "claude-code": true, codex: true },
    failNext: false,
    evidence: NO_SAVE_EVIDENCE,
  };
}

export function cloneWorld(world: World): World {
  return structuredClone(world);
}

/** Opaque evidence may hold Maps and Sets; JSON alone would drop them. */
export function worldKey(world: World): string {
  return JSON.stringify(world, (_key, value: unknown) => {
    if (value instanceof Map) return { map: [...value.entries()] };
    if (value instanceof Set) return { set: [...value.values()] };
    return value;
  });
}

export type WorldEvent =
  | { readonly kind: "save" }
  | { readonly kind: "accept" }
  | { readonly kind: "refuse" }
  | { readonly kind: "deliver" }
  | { readonly kind: "rebind" }
  | { readonly kind: "provider-fail" }
  /** A later revision turns Traycer memories off and this host reads it. Only injected inside a save: no save can undo it. */
  | { readonly kind: "overturn" }
  | { readonly kind: "mode"; readonly mode: SetMode };

export function eventLabel(event: WorldEvent): string {
  return event.kind === "mode" ? `mode:${event.mode}` : event.kind;
}

function oldestPending(world: World): Upload | undefined {
  return world.uploads.find(
    (upload) => upload.env === world.bound && upload.state === "pending",
  );
}

/** The events that change the world and make sense from here. */
export function applicableEvents(world: World): ReadonlyArray<WorldEvent> {
  const events: WorldEvent[] = [{ kind: "save" }];
  if (oldestPending(world) !== undefined)
    events.push({ kind: "accept" }, { kind: "refuse" });
  const config = world.cfg[world.bound];
  const received = world.received[world.bound];
  if (received.revision !== config.revision || received.value !== config.value)
    events.push({ kind: "deliver" });
  events.push({ kind: "rebind" });
  if (!world.failNext) events.push({ kind: "provider-fail" });
  for (const mode of ["applied", "saved", "queued"] as const)
    if (mode !== world.mode) events.push({ kind: "mode", mode });
  return events;
}

/** Everything but a save, which needs the save's own run. */
export function applyWorldEvent(world: World, event: WorldEvent): void {
  switch (event.kind) {
    case "save":
      throw new Error("a save is run, not applied");
    case "accept": {
      const upload = oldestPending(world);
      if (upload === undefined) return;
      const config = world.cfg[upload.env];
      config.revision += 1;
      config.value = true;
      upload.state = "accepted";
      world.receipts.push({
        uploadId: upload.id,
        environmentId: upload.env,
        revision: config.revision,
      });
      return;
    }
    case "refuse": {
      const upload = oldestPending(world);
      if (upload !== undefined) upload.state = "refused";
      return;
    }
    case "deliver":
      world.received[world.bound] = { ...world.cfg[world.bound] };
      return;
    case "rebind":
      world.bound = world.bound === "A" ? "B" : "A";
      return;
    case "provider-fail":
      world.failNext = true;
      return;
    case "overturn": {
      const config = world.cfg[world.bound];
      config.revision += 1;
      config.value = false;
      world.received[world.bound] = { ...config };
      return;
    }
    case "mode":
      world.mode = event.mode;
  }
}

/** The act already has a write in this configuration, held or taken. */
function actWriteIn(world: World, env: Env): boolean {
  return (
    world.wrote[env] ||
    world.uploads.some(
      (upload) =>
        upload.env === env &&
        (upload.state === "pending" || upload.state === "accepted"),
    )
  );
}

export type ViolationClass =
  | "D done though a provider write did not land"
  | "S more than one set in one save"
  | "R runaway save: more than 30 requests"
  | "I1 write/done with no read in this save"
  | "I1 write/done straight after a set"
  | "I1 write/done straight after a status lookup"
  | "I1 write/done straight after a provider write"
  | "I1 write/done on a read that said off"
  | "H harm: write/done with no read, bound configuration's received value off"
  | "H harm: write/done after a set, bound configuration's received value off"
  | "H harm: write/done after a status lookup, received value off"
  | "I2 set while the configuration has this act's write"
  | "B second request after an unseen rebind"
  | "I4 standing on though the read's configuration was off"
  | "I3 request after the selection moved"
  | "I3 done after the selection moved";

export interface Violation {
  readonly cls: ViolationClass;
}

interface RequestRecord {
  readonly name: "get" | "status" | "set" | "provider";
  /** A get: whether the host had received Traycer memories as on. */
  readonly receivedOn: boolean;
  /** A rebind landed after this request's answer. */
  rebound: boolean;
}

/** One injected change, made after the `after`-th answer of a save. */
export interface Injection {
  readonly after: number;
  readonly label: string;
  readonly apply: (world: World, selection: { selected: boolean }) => void;
}

export interface SaveRun {
  readonly result: MemorySaveResult;
  readonly requests: number;
  readonly violations: ReadonlyArray<Violation>;
  /** Windows where a rebind came between a read and the request after it. */
  readonly exemptWindows: number;
  /** The save's requests in order, for reading a counterexample. */
  readonly trace: ReadonlyArray<string>;
  /** Runs where exactly one request landed after an unseen rebind. */
  readonly oneAfterRebind: number;
}

const ROWS = (world: World): ReadonlyArray<OnboardingMemoryRow> =>
  (["claude-code", "codex"] as const).map((providerId) => ({
    providerId,
    name: providerId,
    value: false,
    stored: world.providers[providerId],
    outcome: null,
  }));

/** One save, run to its end against `world`, which it changes. */
export async function runSave(
  world: World,
  injection: Injection | null,
): Promise<SaveRun> {
  const selection = { selected: true };
  const violations: Violation[] = [];
  let lastRequest: RequestRecord | null = null;
  let answers = 0;
  let exemptWindows = 0;
  /** A rebind landed and no read has named the new configuration yet. */
  const rebind = {
    unseen: false,
    landed: 0,
    lastWasProvider: false,
    ones: 0,
  };
  /** The save's last successful read, and whether the host had received it on. */
  const reads: {
    last: {
      answer: ConfigAgentMemoriesResponse;
      receivedOn: boolean;
    } | null;
  } = { last: null };

  const counts = { requests: 0, sets: 0 };
  const trace: string[] = [];
  const flag = (cls: ViolationClass): void => {
    violations.push({ cls });
  };
  /** After each answer, before the save carries on: the point a change can land. */
  const answered = async (): Promise<void> => {
    answers += 1;
    await Promise.resolve();
    if (injection !== null && injection.after === answers) {
      const boundBefore = world.bound;
      injection.apply(world, selection);
      if (world.bound !== boundBefore) {
        rebind.unseen = true;
        rebind.landed = 0;
        rebind.lastWasProvider = false;
      }
      // A rebind or a later revision landing right after a read is a window
      // no request can close: none names the configuration it expects.
      if (
        (world.bound !== boundBefore || injection.label === "overturn") &&
        lastRequest !== null &&
        lastRequest.name === "get"
      )
        lastRequest.rebound = true;
    }
  };
  const sent = (name: "get" | "status" | "set" | "provider"): void => {
    counts.requests += 1;
    trace.push(name);
    if (counts.requests === 31) flag("R runaway save: more than 30 requests");
    if (name === "get") {
      if (rebind.unseen && rebind.landed === 1) rebind.ones += 1;
      rebind.unseen = false;
    } else if (
      rebind.unseen &&
      !(name === "provider" && rebind.lastWasProvider)
    ) {
      rebind.landed += 1;
      if (rebind.landed > 1) flag("B second request after an unseen rebind");
    }
    rebind.lastWasProvider = name === "provider";
    if (!selection.selected) flag("I3 request after the selection moved");
  };
  /** The state a provider write or "done" stands on. */
  const standsOnRead = (): void => {
    const harmed =
      !world.received[world.bound].value &&
      !(lastRequest !== null && lastRequest.rebound);
    if (harmed) {
      if (lastRequest === null)
        flag(
          "H harm: write/done with no read, bound configuration's received value off",
        );
      else if (lastRequest.name === "set")
        flag(
          "H harm: write/done after a set, bound configuration's received value off",
        );
      else flag("H harm: write/done after a status lookup, received value off");
    }
    if (lastRequest === null)
      return flag("I1 write/done with no read in this save");
    if (lastRequest.name === "set")
      return flag("I1 write/done straight after a set");
    if (lastRequest.name === "status")
      return flag("I1 write/done straight after a status lookup");
    if (lastRequest.name === "provider")
      return flag("I1 write/done straight after a provider write");
    if (lastRequest.rebound) {
      exemptWindows += 1;
      return;
    }
    if (!lastRequest.receivedOn) flag("I1 write/done on a read that said off");
  };

  const io: MemorySaveIo = {
    current: () => selection.selected,
    read: async () => {
      sent("get");
      // A save that will not stop is cut off here, so the exploration ends.
      if (counts.requests > 30) return null;
      const received = world.received[world.bound];
      const answer: ConfigAgentMemoriesResponse = {
        enabled: received.value,
        revision: received.revision,
        environmentId: world.bound,
      };
      lastRequest = { name: "get", receivedOn: received.value, rebound: false };
      reads.last = { answer, receivedOn: received.value };
      await answered();
      return answer;
    },
    lookUp: async () => {
      sent("status");
      const answer: UploadStatus = {
        acceptedUploads: world.receipts.map((receipt) => ({
          uploadId: receipt.uploadId,
          environmentId: receipt.environmentId,
          revision: receipt.revision,
          kind: "agent_memory",
          key: "memory",
          os: "any",
          acceptedAt: 0,
        })),
        pendingUploads: world.uploads
          .filter((upload) => upload.state !== "accepted")
          .map((upload) => ({
            uploadId: upload.id,
            kind: "agent_memory",
            key: "memory",
            os: "any",
            queuedAt: 0,
            receipt: upload.state,
            code: null,
          })),
      };
      lastRequest = { name: "status", receivedOn: false, rebound: false };
      await answered();
      return answer;
    },
    set: async () => {
      sent("set");
      counts.sets += 1;
      if (counts.sets === 2) flag("S more than one set in one save");
      const previous = lastRequest;
      const window = previous?.name === "get" && previous.rebound;
      if (window) exemptWindows += 1;
      else if (actWriteIn(world, world.bound))
        flag("I2 set while the configuration has this act's write");
      const env = world.bound;
      let answer: ConfigAgentMemoriesSetResponse;
      if (world.mode === "queued") {
        const id = `u${world.nextId}`;
        world.nextId += 1;
        world.uploads.push({ id, env, state: "pending" });
        answer = {
          enabled: false,
          state: "queued",
          revision: null,
          environmentId: env,
          uploadId: id,
        };
      } else {
        const config = world.cfg[env];
        config.revision += 1;
        config.value = true;
        world.wrote[env] = true;
        if (world.mode === "applied") world.received[env] = { ...config };
        answer = {
          enabled: world.mode === "applied",
          state: world.mode,
          revision: config.revision,
          environmentId: env,
          uploadId: null,
        };
      }
      lastRequest = { name: "set", receivedOn: false, rebound: false };
      await answered();
      return answer;
    },
    writeProvider: async (row) => {
      sent("provider");
      standsOnRead();
      lastRequest = { name: "provider", receivedOn: false, rebound: false };
      const key = row.providerId === "codex" ? "codex" : "claude-code";
      let landed = true;
      if (world.failNext) {
        world.failNext = false;
        landed = false;
      } else world.providers[key] = false;
      await answered();
      return landed;
    },
    evidence: () => world.evidence,
    record: (next) => {
      world.evidence = next;
    },
  };

  const result = await runMemorySave(io, ROWS(world));
  if (result === "done") {
    if (Object.values(world.providers).some((on) => on))
      flag("D done though a provider write did not land");
    if (!selection.selected) flag("I3 done after the selection moved");
    standsOnRead();
  }
  // I4: what the act would show from the save's last read and its evidence.
  const lastGet = reads.last;
  if (
    lastGet !== null &&
    lastGet.answer.environmentId !== null &&
    traycerStanding(
      lastGet.answer,
      world.evidence.get(lastGet.answer.environmentId),
    ) === "on" &&
    !lastGet.receivedOn
  )
    flag("I4 standing on though the read's configuration was off");
  return {
    result,
    requests: answers,
    violations,
    exemptWindows,
    trace,
    oneAfterRebind:
      rebind.ones + (rebind.unseen && rebind.landed === 1 ? 1 : 0),
  };
}
