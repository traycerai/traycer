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
import {
  emptyMemoryDraft,
  memoryRowsFor,
  withProviderChoice,
  type ProviderMemoryOutcome,
} from "@/components/onboarding/onboarding-agent-memories-model";
import { providerState } from "@/components/onboarding/__tests__/onboarding-memory-act-provider-state";
import {
  NO_SAVE_EVIDENCE,
  type MemorySaveRows,
  runMemorySave,
  traycerStanding,
  type MemorySaveIo,
  type MemorySaveResult,
  type SaveEvidence,
  type UploadStatus,
} from "@/components/onboarding/onboarding-memory-save";

export type Env = "A" | "B";
export type Switchable = "claude-code" | "codex";
const SWITCHABLE: ReadonlyArray<Switchable> = ["claude-code", "codex"];
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

/**
 * What the act's host has said about the providers it can switch.
 * `unknown`: not yet (the act shows "Checking your providers").
 * `failed`: the list could not be read (the person is told, and Traycer
 * memories alone are written). `none`: read, and none can be switched.
 * `known`: read, and claude-code and codex can.
 */
export type Discovery = "unknown" | "failed" | "none" | "known";

export interface World {
  discovery: Discovery;
  /**
   * A provider's own memory was turned back on elsewhere after the act's
   * list read, and no fresh read or landed write has settled it since. The
   * accepted limit: a save skips a row whose `stored` already matches.
   */
  elsewhere: Record<Switchable, boolean>;
  /** What the act's last `providers.list` read says of each provider's own memory. */
  snapshot: Record<Switchable, boolean>;
  /** The person's switch for each provider: `false` is "turn it off". */
  choice: Record<Switchable, boolean>;
  /** The act's own last write of each provider on this host, as the hook records it. */
  writes: Record<Switchable, ProviderMemoryOutcome | null>;
  cfg: Record<Env, ConfigState>;
  received: Record<Env, ConfigState>;
  bound: Env;
  mode: SetMode;
  uploads: Upload[];
  receipts: Receipt[];
  /** A set of this act the configuration saved at once (applied or saved). */
  wrote: Record<Env, boolean>;
  nextId: number;
  /** What the host really holds of each provider's own memory. */
  providers: Record<Switchable, boolean>;
  failNext: boolean;
  evidence: SaveEvidence;
}

export function initialWorld(): World {
  return {
    discovery: "known",
    elsewhere: { "claude-code": false, codex: false },
    snapshot: { "claude-code": true, codex: true },
    choice: { "claude-code": false, codex: false },
    writes: { "claude-code": null, codex: null },
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
  /** The act's host answers its provider list: switchable ones, none, or a failure. */
  | { readonly kind: "discover"; readonly outcome: "known" | "none" | "failed" }
  /** The act moves to a host whose providers are not known yet. */
  | { readonly kind: "switch-host" }
  /** The person flips one provider's switch. Disabled while a save runs. */
  | { readonly kind: "toggle"; readonly provider: Switchable }
  /** Traycer is switched off: every provider choice is dropped. */
  | { readonly kind: "traycer-off" }
  /** The act's provider list is read again. */
  | { readonly kind: "refresh" }
  /** A provider's own memory is turned back on elsewhere after discovery. */
  | { readonly kind: "elsewhere" }
  /** A later revision turns Traycer memories off and this host reads it. Only injected inside a save: no save can undo it. */
  | { readonly kind: "overturn" }
  | { readonly kind: "mode"; readonly mode: SetMode };

export function eventLabel(event: WorldEvent): string {
  if (event.kind === "mode") return `mode:${event.mode}`;
  if (event.kind === "discover") return `discover:${event.outcome}`;
  if (event.kind === "toggle") return `toggle:${event.provider}`;
  return event.kind;
}

function oldestPending(world: World): Upload | undefined {
  return world.uploads.find(
    (upload) => upload.env === world.bound && upload.state === "pending",
  );
}

/** What the person and the act's list read can do once the providers are known. */
function personEvents(world: World): WorldEvent[] {
  if (world.discovery !== "known") return [];
  const events: WorldEvent[] = SWITCHABLE.map((provider) => ({
    kind: "toggle",
    provider,
  }));
  if (SWITCHABLE.some((provider) => world.choice[provider]))
    events.push({ kind: "traycer-off" });
  if (SWITCHABLE.some((p) => world.snapshot[p] !== world.providers[p]))
    events.push({ kind: "refresh" });
  return events;
}

/** The events that change the world and make sense from here. */
export function applicableEvents(
  world: World,
  elsewhere: boolean,
): ReadonlyArray<WorldEvent> {
  const events: WorldEvent[] = [{ kind: "save" }];
  if (world.discovery === "unknown")
    for (const outcome of ["known", "none", "failed"] as const)
      events.push({ kind: "discover", outcome });
  else events.push({ kind: "switch-host" });
  events.push(...personEvents(world));
  if (
    elsewhere &&
    world.discovery === "known" &&
    (!world.providers["claude-code"] || !world.providers.codex)
  )
    events.push({ kind: "elsewhere" });
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

function applyPersonEvent(world: World, event: WorldEvent): void {
  switch (event.kind) {
    case "discover":
      world.discovery = event.outcome;
      world.snapshot = { ...world.providers };
      world.elsewhere = { "claude-code": false, codex: false };
      return;
    case "elsewhere": {
      const turned = world.providers["claude-code"] ? "codex" : "claude-code";
      world.providers[turned] = true;
      world.elsewhere[turned] = true;
      return;
    }
    case "switch-host":
      world.discovery = "unknown";
      world.choice = { "claude-code": false, codex: false };
      world.writes = { "claude-code": null, codex: null };
      return;
    case "toggle":
      world.choice[event.provider] = !world.choice[event.provider];
      return;
    case "traycer-off":
      world.choice = { "claude-code": false, codex: false };
      return;
    case "refresh":
      world.snapshot = { ...world.providers };
      for (const provider of SWITCHABLE)
        if (world.writes[provider] === null) world.elsewhere[provider] = false;
      return;
    default:
      throw new Error(`not a person's event: ${event.kind}`);
  }
}

function applyHostEvent(world: World, event: WorldEvent): void {
  switch (event.kind) {
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
    default:
      throw new Error(`not a host event: ${event.kind}`);
  }
}

/** Everything but a save, which needs the save's own run. */
export function applyWorldEvent(world: World, event: WorldEvent): void {
  switch (event.kind) {
    case "save":
      throw new Error("a save is run, not applied");
    case "accept":
    case "refuse":
    case "deliver":
    case "rebind":
    case "provider-fail":
    case "overturn":
      applyHostEvent(world, event);
      return;
    case "mode":
      world.mode = event.mode;
      return;
    default:
      applyPersonEvent(world, event);
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
  | "D done though the host's provider is not what the person chose"
  | "U a save with undiscovered providers sent a request or finished"
  | "X a request followed the stale read that done stood on"
  | "X a request after the save finished"
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
  /**
   * "Done on a read that was true when taken": a rebind or a later revision
   * landed after the final read's answer, and the save returned done on it.
   * The irreducible staleness of a read; closing it takes one atomic host
   * operation. Bounded here: no request follows that read, and none after done.
   */
  readonly staleDone: number;
  /** Saves done on a failed provider list: the person was told, and went on. */
  readonly failedDiscoveryDone: number;
  /**
   * Saves done with a provider on that was turned back on elsewhere after
   * the list read: the accepted limit, counted per occurrence.
   */
  readonly elsewhereDone: number;
}

/**
 * The rows a save is given: the real model's, from the list the act last
 * read, the person's choices and the act's own writes.
 */
const rowsFor = (world: World): MemorySaveRows => {
  if (world.discovery === "unknown") return null;
  if (world.discovery !== "known") return [];
  let draft = emptyMemoryDraft("host");
  for (const provider of SWITCHABLE)
    draft = withProviderChoice(draft, provider, world.choice[provider]);
  const writes = new Map(
    SWITCHABLE.flatMap((provider) => {
      const written = world.writes[provider];
      return written === null ? [] : [[provider, written] as const];
    }),
  );
  return memoryRowsFor(
    SWITCHABLE.map((providerId) =>
      providerState({
        providerId,
        enabled: true,
        supported: true,
        nativeMemory: world.snapshot[providerId],
      }),
    ),
    draft,
    writes,
  ).rows;
};

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
  let staleDone = 0;
  let failedDiscoveryDone = 0;
  let elsewhereDone = 0;
  /** Requests made when a change landed after a read's answer. */
  let injectedAt: number | null = null;
  let finished = false;
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
      ) {
        lastRequest.rebound = true;
        injectedAt = trace.length;
      }
    }
  };
  const sent = (name: "get" | "status" | "set" | "provider"): void => {
    if (finished) flag("X a request after the save finished");
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
    // The window is only for a read that was on when taken.
    if (!lastRequest.receivedOn) flag("I1 write/done on a read that said off");
    else if (lastRequest.rebound) exemptWindows += 1;
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
      } else {
        world.providers[key] = row.value;
        world.elsewhere[key] = false;
      }
      // The hook keeps its own write apart from the list, which may be a
      // read from before it.
      world.writes[key] = {
        kind: landed ? "saved" : "failed",
        value: row.value,
      };
      await answered();
      return landed;
    },
    evidence: () => world.evidence,
    record: (next) => {
      world.evidence = next;
    },
  };

  const startedUnknown = world.discovery === "unknown";
  const result = await runMemorySave(io, rowsFor(world));
  finished = true;
  if (result === "done") {
    // Done means every provider the host can switch has its own memory off,
    // checked against the host and not against the rows the save was given.
    const atDone = providersAtDone(world);
    if (atDone === "on")
      flag("D done though the host's provider is not what the person chose");
    if (atDone === "elsewhere") elsewhereDone += 1;
    // A failed list was said on the act; the person went on without it.
    if (atDone === "unread") failedDiscoveryDone += 1;
    if (!selection.selected) flag("I3 done after the selection moved");
    // Read through a function: the closures above assign these, which the
    // checker does not follow from here.
    const final = (): {
      rebound: boolean;
      readOn: boolean;
      at: number | null;
    } => ({
      rebound: lastRequest !== null && lastRequest.rebound,
      readOn: lastRequest !== null && lastRequest.receivedOn,
      at: injectedAt,
    });
    if (final().rebound) {
      // The named exemption: done on a read that was ON when taken.
      if (!final().readOn) flag("I1 write/done on a read that said off");
      staleDone += 1;
      if (final().at !== trace.length)
        flag("X a request followed the stale read that done stood on");
    } else standsOnRead();
  }
  // U: a save begun before the host said which providers it can switch
  // sends nothing and is not done.
  if (startedUnknown && (result !== "undiscovered" || counts.requests > 0))
    flag("U a save with undiscovered providers sent a request or finished");
  // I4: what the act would show from the save's last read and its evidence.
  if (standingOnAnOffRead(world, reads.last))
    flag("I4 standing on though the read's configuration was off");
  return {
    result,
    requests: answers,
    violations,
    exemptWindows,
    trace,
    staleDone,
    failedDiscoveryDone,
    elsewhereDone,
    oneAfterRebind:
      rebind.ones + (rebind.unseen && rebind.landed === 1 ? 1 : 0),
  };
}

/**
 * Where the host's switchable providers stand when a save returns done:
 * `on` if one differs from the person's choice for no named reason,
 * `elsewhere` if every one that differs was changed elsewhere after the list
 * read (the accepted limit), `unread` if the provider list failed (so none
 * are known), `off` if every one is what the person chose.
 */
function providersAtDone(world: World): "off" | "on" | "unread" | "elsewhere" {
  if (world.discovery === "failed") return "unread";
  if (world.discovery !== "known") return "off";
  const differing = SWITCHABLE.filter(
    (provider) => world.providers[provider] !== world.choice[provider],
  );
  if (differing.length === 0) return "off";
  return differing.every((provider) => world.elsewhere[provider])
    ? "elsewhere"
    : "on";
}

/** The act would show "on" from this read though the host had received it off. */
function standingOnAnOffRead(
  world: World,
  read: {
    answer: ConfigAgentMemoriesResponse;
    receivedOn: boolean;
  } | null,
): boolean {
  if (read === null || read.answer.environmentId === null) return false;
  const standing = traycerStanding(
    read.answer,
    world.evidence.get(read.answer.environmentId),
  );
  return standing === "on" && !read.receivedOn;
}
