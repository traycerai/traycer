/**
 * The pending-send lifecycle as one pure transition table.
 *
 * Every state × event cell of the contract is a named case, `PS.<state>.<event>`
 * (the same ids as the table in the pull request). The expected values come
 * from that contract, not from the engine: a cell names the next state, the
 * exact effects the adapters must run, and whether the event was applied,
 * ignored as stale, refused because the claim is live, or unreachable.
 *
 * The matrix runs under default facts (original account, owner, native lock,
 * durable claim iff claimed). The guard partitions below change one fact at a
 * time: another account, a mismatched claim, a missing lock, an unknown row,
 * no client, a changed stage.
 */
import { describe, expect, it } from "vitest";
import {
  decodePendingSandboxObservation,
  type PendingSandboxObservation,
} from "../pending-sandbox-observation";
import {
  pendingSendState,
  transitionPendingSend,
  type PendingSendBlocker,
  type PendingSendEvent,
  type PendingSendFacts,
  type PendingSendPhase,
  type PendingSendState,
  type PendingSendTransition,
} from "../pending-sandbox-send-transition";
import { pendingSend } from "./pending-send-fixtures";

type Kind = PendingSendState["kind"];
type Outcome = "applied" | "ignored" | "denied-claim" | "unreachable";

interface Row {
  readonly id: string;
  /** `staged` is the pre-handoff state; the engine names it the same. */
  readonly phase: string;
  readonly blocker: string;
}

/** `[next row, "+"-joined effects, outcome code]`; `RC` is returned or cancelled by kind. */
type Cell = readonly [string, string, "a" | "i" | "d" | "u"];

const ROWS: ReadonlyArray<Row> = [
  { id: "P", phase: "staged", blocker: "none" },
  { id: "U", phase: "unconfirmed", blocker: "none" },
  { id: "W.host", phase: "waiting", blocker: "host" },
  { id: "W.model", phase: "waiting", blocker: "model" },
  { id: "W.provider", phase: "waiting", blocker: "provider" },
  { id: "W.credits", phase: "waiting", blocker: "credits" },
  { id: "W.settings", phase: "waiting", blocker: "settings" },
  { id: "W.notsent", phase: "waiting", blocker: "not-sent" },
  { id: "W.wake", phase: "waiting", blocker: "wake" },
  { id: "W.none", phase: "waiting", blocker: "none" },
  { id: "W.stop", phase: "waiting", blocker: "stop" },
  { id: "S.none", phase: "sending", blocker: "none" },
  { id: "S.host", phase: "sending", blocker: "host" },
  { id: "S.credits", phase: "sending", blocker: "credits" },
  { id: "S.settings", phase: "sending", blocker: "settings" },
  { id: "S.wake", phase: "sending", blocker: "wake" },
  { id: "Q.none", phase: "uncertain", blocker: "none" },
  { id: "Q.host", phase: "uncertain", blocker: "host" },
  { id: "Q.credits", phase: "uncertain", blocker: "credits" },
  { id: "Q.settings", phase: "uncertain", blocker: "settings" },
  { id: "Q.client", phase: "uncertain", blocker: "client" },
  { id: "Q.wake", phase: "uncertain", blocker: "wake" },
  { id: "A", phase: "accepted", blocker: "none" },
  { id: "E", phase: "ended", blocker: "none" },
  { id: "D", phase: "delivered", blocker: "none" },
  { id: "C", phase: "cancelled", blocker: "none" },
  { id: "R", phase: "returned", blocker: "none" },
];

const EVENTS: ReadonlyArray<string> = [
  "confirm",
  "cancel",
  "choose",
  "stop",
  "return",
  "retry",
  "retry-stage",
  "retry-creation",
  "keep-waiting",
  "handoff",
  "stage-change",
  "dialog-close",
  "attach-ok",
  "attach-unsupported",
  "attach-failed",
  "agent-ready",
  "agent-not-ready",
  "prepared",
  "prepare-failed",
  "claim-saved",
  "claim-write-failed",
  "host-accept",
  "receipt-saved",
  "receipt-write-failed",
  "known-refusal",
  "transport-fail",
  "late-accept",
  "stop-result",
  "stop-failed",
  "rest",
  "awake",
  "terminal-row",
  "frozen",
  "unfrozen",
  "settings",
  "settings-repaired",
  "wake-failed",
  "null-client",
  "client-restored",
  "access-lost",
  "task-deleted",
  "epic-create-failed",
  "task-interrupted",
  "stage-lost",
  "account-away",
  "account-back",
  "reload",
  "storage-changed",
  "disposition-persisted",
  "recovery-complete",
];

/** The facts an event carries beyond the defaults. */
const OVERLAY: Readonly<Record<string, Partial<PendingSendFacts>>> = {
  rest: {
    host: "resting",
  },
  awake: {
    host: "awake",
  },
  "terminal-row": {
    host: "ended",
  },
  "access-lost": {
    host: "ended",
  },
  frozen: {
    host: "awake",
    frozen: true,
  },
  unfrozen: {
    host: "awake",
  },
  settings: {
    host: "awake",
    settingsReady: false,
  },
  "settings-repaired": {
    host: "awake",
  },
  "agent-ready": {
    host: "awake",
    agentReady: true,
  },
  "agent-not-ready": {
    host: "awake",
    agentReady: false,
  },
  "null-client": {
    host: "awake",
    clientReady: false,
  },
  "client-restored": {
    host: "awake",
    clientReady: true,
  },
  "wake-failed": {
    host: "resting",
  },
  retry: {
    host: "awake",
  },
  "claim-saved": {
    host: "awake",
  },
  "account-away": {
    accountActive: false,
  },
};

const GRID: Readonly<Record<string, Readonly<Record<string, Cell>>>> = {
  P: {
    confirm: ["P", "", "u"],
    cancel: ["P", "", "u"],
    choose: ["P", "", "u"],
    stop: ["P", "", "u"],
    return: ["P", "", "u"],
    retry: ["P", "", "u"],
    "retry-stage": ["P", "", "u"],
    "retry-creation": ["P", "", "u"],
    "keep-waiting": ["P", "", "u"],
    handoff: ["W.host", "handoff", "a"],
    "stage-change": ["P", "", "i"],
    "dialog-close": ["P", "", "i"],
    "attach-ok": ["W.host", "handoff", "a"],
    "attach-unsupported": ["W.host", "handoff", "a"],
    "attach-failed": ["P", "", "i"],
    "agent-ready": ["P", "", "u"],
    "agent-not-ready": ["P", "", "u"],
    prepared: ["P", "", "u"],
    "prepare-failed": ["P", "", "u"],
    "claim-saved": ["P", "", "u"],
    "claim-write-failed": ["P", "", "u"],
    "host-accept": ["P", "", "u"],
    "receipt-saved": ["P", "", "u"],
    "receipt-write-failed": ["P", "", "u"],
    "known-refusal": ["P", "", "u"],
    "transport-fail": ["P", "", "u"],
    "late-accept": ["P", "", "i"],
    "stop-result": ["P", "", "u"],
    "stop-failed": ["P", "", "u"],
    rest: ["P", "", "u"],
    awake: ["P", "", "u"],
    "terminal-row": ["P", "", "u"],
    frozen: ["P", "", "u"],
    unfrozen: ["P", "", "u"],
    settings: ["P", "", "u"],
    "settings-repaired": ["P", "", "u"],
    "wake-failed": ["P", "", "u"],
    "null-client": ["P", "", "u"],
    "client-restored": ["P", "", "u"],
    "access-lost": ["P", "", "u"],
    "task-deleted": ["P", "", "u"],
    "epic-create-failed": ["P", "", "u"],
    "task-interrupted": ["P", "", "u"],
    "stage-lost": ["P", "", "u"],
    "account-away": ["P", "", "i"],
    "account-back": ["P", "", "u"],
    reload: ["P", "", "u"],
    "storage-changed": ["P", "", "u"],
    "disposition-persisted": ["P", "", "u"],
    "recovery-complete": ["P", "", "u"],
  },
  U: {
    confirm: ["W.host", "confirm-epic", "a"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["RC", "ret+remove", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["U", "", "i"],
    "retry-stage": ["U", "", "i"],
    "retry-creation": ["U", "", "i"],
    "keep-waiting": ["U", "", "i"],
    handoff: ["U", "", "i"],
    "stage-change": ["U", "", "i"],
    "dialog-close": ["U", "", "i"],
    "attach-ok": ["U", "", "i"],
    "attach-unsupported": ["U", "", "i"],
    "attach-failed": ["U", "", "i"],
    "agent-ready": ["U", "", "i"],
    "agent-not-ready": ["U", "", "i"],
    prepared: ["U", "", "u"],
    "prepare-failed": ["U", "", "u"],
    "claim-saved": ["U", "", "u"],
    "claim-write-failed": ["U", "", "u"],
    "host-accept": ["U", "", "u"],
    "receipt-saved": ["U", "", "u"],
    "receipt-write-failed": ["U", "", "u"],
    "known-refusal": ["U", "", "u"],
    "transport-fail": ["U", "", "u"],
    "late-accept": ["U", "", "i"],
    "stop-result": ["U", "", "i"],
    "stop-failed": ["U", "", "i"],
    rest: ["U", "", "i"],
    awake: ["U", "", "i"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["U", "", "i"],
    unfrozen: ["U", "", "i"],
    settings: ["U", "", "i"],
    "settings-repaired": ["U", "", "i"],
    "wake-failed": ["U", "", "i"],
    "null-client": ["U", "", "i"],
    "client-restored": ["U", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["RC", "ret+remove", "a"],
    "epic-create-failed": ["RC", "ret+remove", "a"],
    "task-interrupted": ["RC", "ret+remove", "a"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["U", "", "i"],
    "account-back": ["U", "", "i"],
    reload: ["U", "", "i"],
    "storage-changed": ["U", "", "i"],
    "disposition-persisted": ["U", "", "i"],
    "recovery-complete": ["U", "", "i"],
  },
  "W.host": {
    confirm: ["W.host", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.host", "", "i"],
    "retry-stage": ["W.host", "", "i"],
    "retry-creation": ["W.host", "", "i"],
    "keep-waiting": ["W.host", "", "i"],
    handoff: ["W.host", "", "i"],
    "stage-change": ["W.host", "", "i"],
    "dialog-close": ["W.host", "", "i"],
    "attach-ok": ["W.host", "", "i"],
    "attach-unsupported": ["W.host", "", "i"],
    "attach-failed": ["W.host", "", "i"],
    "agent-ready": ["W.none", "prepare", "a"],
    "agent-not-ready": ["W.provider", "report-provider+poll", "a"],
    prepared: ["W.host", "", "i"],
    "prepare-failed": ["W.host", "", "i"],
    "claim-saved": ["W.host", "", "i"],
    "claim-write-failed": ["W.host", "", "i"],
    "host-accept": ["W.host", "", "u"],
    "receipt-saved": ["W.host", "", "u"],
    "receipt-write-failed": ["W.host", "", "u"],
    "known-refusal": ["W.host", "", "u"],
    "transport-fail": ["W.host", "", "u"],
    "late-accept": ["W.host", "", "i"],
    "stop-result": ["W.host", "", "i"],
    "stop-failed": ["W.host", "", "i"],
    rest: ["W.host", "poll+wake", "a"],
    awake: ["W.none", "prepare", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.host", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.host", "", "i"],
    "wake-failed": ["W.wake", "report-not-sent", "a"],
    "null-client": ["W.host", "poll", "a"],
    "client-restored": ["W.host", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.host", "", "i"],
    "task-interrupted": ["W.host", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.host", "", "i"],
    "account-back": ["W.host", "poll", "a"],
    reload: ["W.host", "poll", "a"],
    "storage-changed": ["W.host", "poll", "a"],
    "disposition-persisted": ["W.host", "", "i"],
    "recovery-complete": ["W.host", "", "i"],
  },
  "W.model": {
    confirm: ["W.model", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.model", "", "i"],
    "retry-stage": ["W.model", "", "i"],
    "retry-creation": ["W.model", "", "i"],
    "keep-waiting": ["W.model", "", "i"],
    handoff: ["W.model", "", "i"],
    "stage-change": ["W.model", "", "i"],
    "dialog-close": ["W.model", "", "i"],
    "attach-ok": ["W.model", "", "i"],
    "attach-unsupported": ["W.model", "", "i"],
    "attach-failed": ["W.model", "", "i"],
    "agent-ready": ["W.model", "fetch-model+poll", "a"],
    "agent-not-ready": ["W.provider", "report-provider+poll", "a"],
    prepared: ["W.model", "", "i"],
    "prepare-failed": ["W.model", "", "i"],
    "claim-saved": ["W.model", "", "i"],
    "claim-write-failed": ["W.model", "", "i"],
    "host-accept": ["W.model", "", "u"],
    "receipt-saved": ["W.model", "", "u"],
    "receipt-write-failed": ["W.model", "", "u"],
    "known-refusal": ["W.model", "", "u"],
    "transport-fail": ["W.model", "", "u"],
    "late-accept": ["W.model", "", "i"],
    "stop-result": ["W.model", "", "i"],
    "stop-failed": ["W.model", "", "i"],
    rest: ["W.host", "poll+wake", "a"],
    awake: ["W.model", "fetch-model+poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.model", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.model", "", "i"],
    "wake-failed": ["W.wake", "report-not-sent", "a"],
    "null-client": ["W.host", "poll", "a"],
    "client-restored": ["W.model", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.model", "", "i"],
    "task-interrupted": ["W.model", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.model", "", "i"],
    "account-back": ["W.host", "poll", "a"],
    reload: ["W.host", "poll", "a"],
    "storage-changed": ["W.host", "poll", "a"],
    "disposition-persisted": ["W.model", "", "i"],
    "recovery-complete": ["W.model", "", "i"],
  },
  "W.provider": {
    confirm: ["W.provider", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.provider", "", "i"],
    "retry-stage": ["W.provider", "", "i"],
    "retry-creation": ["W.provider", "", "i"],
    "keep-waiting": ["W.provider", "", "i"],
    handoff: ["W.provider", "", "i"],
    "stage-change": ["W.provider", "", "i"],
    "dialog-close": ["W.provider", "", "i"],
    "attach-ok": ["W.provider", "", "i"],
    "attach-unsupported": ["W.provider", "", "i"],
    "attach-failed": ["W.provider", "", "i"],
    "agent-ready": ["W.none", "prepare", "a"],
    "agent-not-ready": ["W.provider", "report-provider+poll", "a"],
    prepared: ["W.provider", "", "i"],
    "prepare-failed": ["W.provider", "", "i"],
    "claim-saved": ["W.provider", "", "i"],
    "claim-write-failed": ["W.provider", "", "i"],
    "host-accept": ["W.provider", "", "u"],
    "receipt-saved": ["W.provider", "", "u"],
    "receipt-write-failed": ["W.provider", "", "u"],
    "known-refusal": ["W.provider", "", "u"],
    "transport-fail": ["W.provider", "", "u"],
    "late-accept": ["W.provider", "", "i"],
    "stop-result": ["W.provider", "", "i"],
    "stop-failed": ["W.provider", "", "i"],
    rest: ["W.host", "poll+wake", "a"],
    awake: ["W.none", "prepare", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.provider", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.provider", "", "i"],
    "wake-failed": ["W.wake", "report-not-sent", "a"],
    "null-client": ["W.host", "poll", "a"],
    "client-restored": ["W.provider", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.provider", "", "i"],
    "task-interrupted": ["W.provider", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.provider", "", "i"],
    "account-back": ["W.host", "poll", "a"],
    reload: ["W.host", "poll", "a"],
    "storage-changed": ["W.host", "poll", "a"],
    "disposition-persisted": ["W.provider", "", "i"],
    "recovery-complete": ["W.provider", "", "i"],
  },
  "W.credits": {
    confirm: ["W.credits", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.credits", "retry+poll", "a"],
    "retry-stage": ["W.credits", "", "i"],
    "retry-creation": ["W.credits", "", "i"],
    "keep-waiting": ["W.credits", "", "i"],
    handoff: ["W.credits", "", "i"],
    "stage-change": ["W.credits", "", "i"],
    "dialog-close": ["W.credits", "", "i"],
    "attach-ok": ["W.credits", "", "i"],
    "attach-unsupported": ["W.credits", "", "i"],
    "attach-failed": ["W.credits", "", "i"],
    "agent-ready": ["W.credits", "poll", "a"],
    "agent-not-ready": ["W.credits", "poll", "a"],
    prepared: ["W.credits", "", "i"],
    "prepare-failed": ["W.credits", "", "i"],
    "claim-saved": ["W.credits", "", "i"],
    "claim-write-failed": ["W.credits", "", "i"],
    "host-accept": ["W.credits", "", "u"],
    "receipt-saved": ["W.credits", "", "u"],
    "receipt-write-failed": ["W.credits", "", "u"],
    "known-refusal": ["W.credits", "", "u"],
    "transport-fail": ["W.credits", "", "u"],
    "late-accept": ["W.credits", "", "i"],
    "stop-result": ["W.credits", "", "i"],
    "stop-failed": ["W.credits", "", "i"],
    rest: ["W.credits", "poll", "a"],
    awake: ["W.credits", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.none", "prepare", "a"],
    settings: ["W.credits", "poll", "a"],
    "settings-repaired": ["W.credits", "", "i"],
    "wake-failed": ["W.credits", "", "i"],
    "null-client": ["W.credits", "", "i"],
    "client-restored": ["W.credits", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.credits", "", "i"],
    "task-interrupted": ["W.credits", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.credits", "", "i"],
    "account-back": ["W.host", "poll", "a"],
    reload: ["W.host", "poll", "a"],
    "storage-changed": ["W.host", "poll", "a"],
    "disposition-persisted": ["W.credits", "", "i"],
    "recovery-complete": ["W.credits", "", "i"],
  },
  "W.settings": {
    confirm: ["W.settings", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.settings", "retry+poll", "a"],
    "retry-stage": ["W.settings", "", "i"],
    "retry-creation": ["W.settings", "", "i"],
    "keep-waiting": ["W.settings", "", "i"],
    handoff: ["W.settings", "", "i"],
    "stage-change": ["W.settings", "", "i"],
    "dialog-close": ["W.settings", "", "i"],
    "attach-ok": ["W.settings", "", "i"],
    "attach-unsupported": ["W.settings", "", "i"],
    "attach-failed": ["W.settings", "", "i"],
    "agent-ready": ["W.settings", "poll", "a"],
    "agent-not-ready": ["W.settings", "poll", "a"],
    prepared: ["W.settings", "", "i"],
    "prepare-failed": ["W.settings", "", "i"],
    "claim-saved": ["W.settings", "", "i"],
    "claim-write-failed": ["W.settings", "", "i"],
    "host-accept": ["W.settings", "", "u"],
    "receipt-saved": ["W.settings", "", "u"],
    "receipt-write-failed": ["W.settings", "", "u"],
    "known-refusal": ["W.settings", "", "u"],
    "transport-fail": ["W.settings", "", "u"],
    "late-accept": ["W.settings", "", "i"],
    "stop-result": ["W.settings", "", "i"],
    "stop-failed": ["W.settings", "", "i"],
    rest: ["W.settings", "poll", "a"],
    awake: ["W.settings", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.settings", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.none", "prepare", "a"],
    "wake-failed": ["W.settings", "", "i"],
    "null-client": ["W.settings", "", "i"],
    "client-restored": ["W.settings", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.settings", "", "i"],
    "task-interrupted": ["W.settings", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.settings", "", "i"],
    "account-back": ["W.host", "poll", "a"],
    reload: ["W.host", "poll", "a"],
    "storage-changed": ["W.host", "poll", "a"],
    "disposition-persisted": ["W.settings", "", "i"],
    "recovery-complete": ["W.settings", "", "i"],
  },
  "W.notsent": {
    confirm: ["W.notsent", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.host", "retry+poll", "a"],
    "retry-stage": ["W.host", "poll+retry", "a"],
    "retry-creation": ["W.notsent", "", "i"],
    "keep-waiting": ["W.notsent", "", "i"],
    handoff: ["W.notsent", "", "i"],
    "stage-change": ["W.notsent", "", "i"],
    "dialog-close": ["W.notsent", "", "i"],
    "attach-ok": ["W.notsent", "", "i"],
    "attach-unsupported": ["W.notsent", "", "i"],
    "attach-failed": ["W.notsent", "", "i"],
    "agent-ready": ["W.notsent", "poll", "a"],
    "agent-not-ready": ["W.notsent", "poll", "a"],
    prepared: ["W.notsent", "", "i"],
    "prepare-failed": ["W.notsent", "", "i"],
    "claim-saved": ["W.notsent", "", "i"],
    "claim-write-failed": ["W.notsent", "", "i"],
    "host-accept": ["W.notsent", "", "u"],
    "receipt-saved": ["W.notsent", "", "u"],
    "receipt-write-failed": ["W.notsent", "", "u"],
    "known-refusal": ["W.notsent", "", "u"],
    "transport-fail": ["W.notsent", "", "u"],
    "late-accept": ["W.notsent", "", "i"],
    "stop-result": ["W.notsent", "", "i"],
    "stop-failed": ["W.notsent", "", "i"],
    rest: ["W.notsent", "poll", "a"],
    awake: ["W.notsent", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.notsent", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.notsent", "", "i"],
    "wake-failed": ["W.notsent", "", "i"],
    "null-client": ["W.notsent", "", "i"],
    "client-restored": ["W.notsent", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.notsent", "", "i"],
    "task-interrupted": ["W.notsent", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.notsent", "", "i"],
    "account-back": ["W.notsent", "poll", "a"],
    reload: ["W.notsent", "poll", "a"],
    "storage-changed": ["W.notsent", "poll", "a"],
    "disposition-persisted": ["W.notsent", "", "i"],
    "recovery-complete": ["W.notsent", "", "i"],
  },
  "W.wake": {
    confirm: ["W.wake", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.host", "retry+poll", "a"],
    "retry-stage": ["W.host", "poll+retry", "a"],
    "retry-creation": ["W.wake", "", "i"],
    "keep-waiting": ["W.wake", "", "i"],
    handoff: ["W.wake", "", "i"],
    "stage-change": ["W.wake", "", "i"],
    "dialog-close": ["W.wake", "", "i"],
    "attach-ok": ["W.wake", "", "i"],
    "attach-unsupported": ["W.wake", "", "i"],
    "attach-failed": ["W.wake", "", "i"],
    "agent-ready": ["W.wake", "poll", "a"],
    "agent-not-ready": ["W.wake", "poll", "a"],
    prepared: ["W.wake", "", "i"],
    "prepare-failed": ["W.wake", "", "i"],
    "claim-saved": ["W.wake", "", "i"],
    "claim-write-failed": ["W.wake", "", "i"],
    "host-accept": ["W.wake", "", "u"],
    "receipt-saved": ["W.wake", "", "u"],
    "receipt-write-failed": ["W.wake", "", "u"],
    "known-refusal": ["W.wake", "", "u"],
    "transport-fail": ["W.wake", "", "u"],
    "late-accept": ["W.wake", "", "i"],
    "stop-result": ["W.wake", "", "i"],
    "stop-failed": ["W.wake", "", "i"],
    rest: ["W.wake", "poll", "a"],
    awake: ["W.wake", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.wake", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.wake", "", "i"],
    "wake-failed": ["W.wake", "report-not-sent", "a"],
    "null-client": ["W.wake", "", "i"],
    "client-restored": ["W.wake", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.wake", "", "i"],
    "task-interrupted": ["W.wake", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.wake", "", "i"],
    "account-back": ["W.wake", "poll", "a"],
    reload: ["W.wake", "poll", "a"],
    "storage-changed": ["W.wake", "poll", "a"],
    "disposition-persisted": ["W.wake", "", "i"],
    "recovery-complete": ["W.wake", "", "i"],
  },
  "W.none": {
    confirm: ["W.none", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.none", "", "i"],
    "retry-stage": ["W.none", "", "i"],
    "retry-creation": ["W.none", "", "i"],
    "keep-waiting": ["W.none", "", "i"],
    handoff: ["W.none", "", "i"],
    "stage-change": ["W.none", "", "i"],
    "dialog-close": ["W.none", "", "i"],
    "attach-ok": ["W.none", "", "i"],
    "attach-unsupported": ["W.none", "", "i"],
    "attach-failed": ["W.none", "", "i"],
    "agent-ready": ["W.none", "prepare", "a"],
    "agent-not-ready": ["W.provider", "report-provider+poll", "a"],
    prepared: ["W.none", "persist-claim", "a"],
    "prepare-failed": ["W.notsent", "report-not-sent", "a"],
    "claim-saved": ["S.none", "poll+dispatch", "a"],
    "claim-write-failed": ["W.notsent", "report-not-sent", "a"],
    "host-accept": ["W.none", "", "u"],
    "receipt-saved": ["W.none", "", "u"],
    "receipt-write-failed": ["W.none", "", "u"],
    "known-refusal": ["W.none", "", "u"],
    "transport-fail": ["W.none", "", "u"],
    "late-accept": ["W.none", "", "i"],
    "stop-result": ["W.none", "", "i"],
    "stop-failed": ["W.none", "", "i"],
    rest: ["W.host", "poll+wake", "a"],
    awake: ["W.none", "prepare", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.credits", "poll", "a"],
    unfrozen: ["W.none", "", "i"],
    settings: ["W.settings", "poll", "a"],
    "settings-repaired": ["W.none", "", "i"],
    "wake-failed": ["W.wake", "report-not-sent", "a"],
    "null-client": ["W.host", "poll", "a"],
    "client-restored": ["W.none", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.none", "", "i"],
    "task-interrupted": ["W.none", "", "i"],
    "stage-lost": ["RC", "ret+remove", "a"],
    "account-away": ["W.none", "", "i"],
    "account-back": ["W.host", "poll", "a"],
    reload: ["W.host", "poll", "a"],
    "storage-changed": ["W.host", "poll", "a"],
    "disposition-persisted": ["W.none", "", "i"],
    "recovery-complete": ["W.none", "", "i"],
  },
  "W.stop": {
    confirm: ["W.stop", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["W.stop", "hold-stop+stop-host", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["W.stop", "", "i"],
    "retry-stage": ["W.stop", "", "i"],
    "retry-creation": ["W.stop", "", "i"],
    "keep-waiting": ["W.stop", "", "i"],
    handoff: ["W.stop", "", "i"],
    "stage-change": ["W.stop", "", "i"],
    "dialog-close": ["W.stop", "", "i"],
    "attach-ok": ["W.stop", "", "i"],
    "attach-unsupported": ["W.stop", "", "i"],
    "attach-failed": ["W.stop", "", "i"],
    "agent-ready": ["W.stop", "poll", "a"],
    "agent-not-ready": ["W.stop", "poll", "a"],
    prepared: ["W.stop", "", "i"],
    "prepare-failed": ["W.stop", "", "i"],
    "claim-saved": ["W.stop", "", "i"],
    "claim-write-failed": ["W.stop", "", "i"],
    "host-accept": ["W.stop", "", "u"],
    "receipt-saved": ["W.stop", "", "u"],
    "receipt-write-failed": ["W.stop", "", "u"],
    "known-refusal": ["W.stop", "", "u"],
    "transport-fail": ["W.stop", "", "u"],
    "late-accept": ["W.stop", "", "i"],
    "stop-result": ["W.stop", "poll", "a"],
    "stop-failed": ["W.stop", "poll", "a"],
    rest: ["RC", "ret+remove", "a"],
    awake: ["W.stop", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["W.stop", "poll", "a"],
    unfrozen: ["W.stop", "poll", "a"],
    settings: ["W.stop", "poll", "a"],
    "settings-repaired": ["W.stop", "poll", "a"],
    "wake-failed": ["W.stop", "", "i"],
    "null-client": ["W.stop", "poll", "a"],
    "client-restored": ["W.stop", "poll", "a"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["W.stop", "", "i"],
    "task-interrupted": ["W.stop", "", "i"],
    "stage-lost": ["W.stop", "poll", "a"],
    "account-away": ["W.stop", "", "i"],
    "account-back": ["W.stop", "poll", "a"],
    reload: ["W.stop", "poll", "a"],
    "storage-changed": ["W.stop", "poll", "a"],
    "disposition-persisted": ["W.stop", "", "i"],
    "recovery-complete": ["W.stop", "", "i"],
  },
  "S.none": {
    confirm: ["S.none", "", "i"],
    cancel: ["S.none", "", "d"],
    choose: ["S.none", "", "d"],
    stop: ["S.none", "", "d"],
    return: ["S.none", "", "d"],
    retry: ["S.none", "retry+poll+dispatch", "a"],
    "retry-stage": ["S.none", "", "i"],
    "retry-creation": ["S.none", "", "i"],
    "keep-waiting": ["S.none", "", "i"],
    handoff: ["S.none", "", "i"],
    "stage-change": ["S.none", "", "i"],
    "dialog-close": ["S.none", "", "i"],
    "attach-ok": ["S.none", "", "i"],
    "attach-unsupported": ["S.none", "", "i"],
    "attach-failed": ["S.none", "", "i"],
    "agent-ready": ["S.none", "", "i"],
    "agent-not-ready": ["S.none", "", "i"],
    prepared: ["S.none", "", "i"],
    "prepare-failed": ["S.none", "", "i"],
    "claim-saved": ["S.none", "", "i"],
    "claim-write-failed": ["S.none", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["S.none", "", "u"],
    "receipt-write-failed": ["S.none", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.none", "uncertain", "a"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["S.none", "", "i"],
    "stop-failed": ["S.none", "", "i"],
    rest: ["S.host", "poll+wake", "a"],
    awake: ["S.none", "poll+dispatch", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["S.credits", "poll", "a"],
    unfrozen: ["S.none", "", "i"],
    settings: ["S.settings", "poll", "a"],
    "settings-repaired": ["S.none", "", "i"],
    "wake-failed": ["S.wake", "report-not-sent", "a"],
    "null-client": ["Q.client", "uncertain+poll", "a"],
    "client-restored": ["S.none", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["S.none", "", "i"],
    "task-interrupted": ["S.none", "", "i"],
    "stage-lost": ["S.none", "", "i"],
    "account-away": ["S.none", "", "i"],
    "account-back": ["S.host", "poll", "a"],
    reload: ["S.host", "poll", "a"],
    "storage-changed": ["S.host", "poll", "a"],
    "disposition-persisted": ["S.none", "", "i"],
    "recovery-complete": ["S.none", "", "i"],
  },
  "S.host": {
    confirm: ["S.host", "", "i"],
    cancel: ["S.host", "", "d"],
    choose: ["S.host", "", "d"],
    stop: ["S.host", "", "d"],
    return: ["S.host", "", "d"],
    retry: ["S.none", "retry+poll+dispatch", "a"],
    "retry-stage": ["S.host", "", "i"],
    "retry-creation": ["S.host", "", "i"],
    "keep-waiting": ["S.host", "", "i"],
    handoff: ["S.host", "", "i"],
    "stage-change": ["S.host", "", "i"],
    "dialog-close": ["S.host", "", "i"],
    "attach-ok": ["S.host", "", "i"],
    "attach-unsupported": ["S.host", "", "i"],
    "attach-failed": ["S.host", "", "i"],
    "agent-ready": ["S.host", "", "i"],
    "agent-not-ready": ["S.host", "", "i"],
    prepared: ["S.host", "", "i"],
    "prepare-failed": ["S.host", "", "i"],
    "claim-saved": ["S.host", "", "i"],
    "claim-write-failed": ["S.host", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["S.host", "", "u"],
    "receipt-write-failed": ["S.host", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.host", "uncertain", "a"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["S.host", "", "i"],
    "stop-failed": ["S.host", "", "i"],
    rest: ["S.host", "poll+wake", "a"],
    awake: ["S.none", "poll+dispatch", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["S.credits", "poll", "a"],
    unfrozen: ["S.host", "", "i"],
    settings: ["S.settings", "poll", "a"],
    "settings-repaired": ["S.host", "", "i"],
    "wake-failed": ["S.wake", "report-not-sent", "a"],
    "null-client": ["Q.client", "uncertain+poll", "a"],
    "client-restored": ["S.host", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["S.host", "", "i"],
    "task-interrupted": ["S.host", "", "i"],
    "stage-lost": ["S.host", "", "i"],
    "account-away": ["S.host", "", "i"],
    "account-back": ["S.host", "poll", "a"],
    reload: ["S.host", "poll", "a"],
    "storage-changed": ["S.host", "poll", "a"],
    "disposition-persisted": ["S.host", "", "i"],
    "recovery-complete": ["S.host", "", "i"],
  },
  "S.credits": {
    confirm: ["S.credits", "", "i"],
    cancel: ["S.credits", "", "d"],
    choose: ["S.credits", "", "d"],
    stop: ["S.credits", "", "d"],
    return: ["S.credits", "", "d"],
    retry: ["S.credits", "retry+poll", "a"],
    "retry-stage": ["S.credits", "", "i"],
    "retry-creation": ["S.credits", "", "i"],
    "keep-waiting": ["S.credits", "", "i"],
    handoff: ["S.credits", "", "i"],
    "stage-change": ["S.credits", "", "i"],
    "dialog-close": ["S.credits", "", "i"],
    "attach-ok": ["S.credits", "", "i"],
    "attach-unsupported": ["S.credits", "", "i"],
    "attach-failed": ["S.credits", "", "i"],
    "agent-ready": ["S.credits", "", "i"],
    "agent-not-ready": ["S.credits", "", "i"],
    prepared: ["S.credits", "", "i"],
    "prepare-failed": ["S.credits", "", "i"],
    "claim-saved": ["S.credits", "", "i"],
    "claim-write-failed": ["S.credits", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["S.credits", "", "u"],
    "receipt-write-failed": ["S.credits", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.credits", "uncertain", "a"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["S.credits", "", "i"],
    "stop-failed": ["S.credits", "", "i"],
    rest: ["S.credits", "poll", "a"],
    awake: ["S.credits", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["S.credits", "poll", "a"],
    unfrozen: ["S.none", "poll+dispatch", "a"],
    settings: ["S.credits", "poll", "a"],
    "settings-repaired": ["S.credits", "", "i"],
    "wake-failed": ["S.credits", "", "i"],
    "null-client": ["Q.credits", "uncertain+poll", "a"],
    "client-restored": ["S.credits", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["S.credits", "", "i"],
    "task-interrupted": ["S.credits", "", "i"],
    "stage-lost": ["S.credits", "", "i"],
    "account-away": ["S.credits", "", "i"],
    "account-back": ["S.host", "poll", "a"],
    reload: ["S.host", "poll", "a"],
    "storage-changed": ["S.host", "poll", "a"],
    "disposition-persisted": ["S.credits", "", "i"],
    "recovery-complete": ["S.credits", "", "i"],
  },
  "S.settings": {
    confirm: ["S.settings", "", "i"],
    cancel: ["S.settings", "", "d"],
    choose: ["S.settings", "", "d"],
    stop: ["S.settings", "", "d"],
    return: ["S.settings", "", "d"],
    retry: ["S.settings", "retry+poll", "a"],
    "retry-stage": ["S.settings", "", "i"],
    "retry-creation": ["S.settings", "", "i"],
    "keep-waiting": ["S.settings", "", "i"],
    handoff: ["S.settings", "", "i"],
    "stage-change": ["S.settings", "", "i"],
    "dialog-close": ["S.settings", "", "i"],
    "attach-ok": ["S.settings", "", "i"],
    "attach-unsupported": ["S.settings", "", "i"],
    "attach-failed": ["S.settings", "", "i"],
    "agent-ready": ["S.settings", "", "i"],
    "agent-not-ready": ["S.settings", "", "i"],
    prepared: ["S.settings", "", "i"],
    "prepare-failed": ["S.settings", "", "i"],
    "claim-saved": ["S.settings", "", "i"],
    "claim-write-failed": ["S.settings", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["S.settings", "", "u"],
    "receipt-write-failed": ["S.settings", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.settings", "uncertain", "a"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["S.settings", "", "i"],
    "stop-failed": ["S.settings", "", "i"],
    rest: ["S.settings", "poll", "a"],
    awake: ["S.settings", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["S.credits", "poll", "a"],
    unfrozen: ["S.settings", "", "i"],
    settings: ["S.settings", "poll", "a"],
    "settings-repaired": ["S.none", "poll+dispatch", "a"],
    "wake-failed": ["S.settings", "", "i"],
    "null-client": ["Q.settings", "uncertain+poll", "a"],
    "client-restored": ["S.settings", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["S.settings", "", "i"],
    "task-interrupted": ["S.settings", "", "i"],
    "stage-lost": ["S.settings", "", "i"],
    "account-away": ["S.settings", "", "i"],
    "account-back": ["S.host", "poll", "a"],
    reload: ["S.host", "poll", "a"],
    "storage-changed": ["S.host", "poll", "a"],
    "disposition-persisted": ["S.settings", "", "i"],
    "recovery-complete": ["S.settings", "", "i"],
  },
  "S.wake": {
    confirm: ["S.wake", "", "i"],
    cancel: ["S.wake", "", "d"],
    choose: ["S.wake", "", "d"],
    stop: ["S.wake", "", "d"],
    return: ["S.wake", "", "d"],
    retry: ["S.none", "retry+poll+dispatch", "a"],
    "retry-stage": ["S.wake", "", "i"],
    "retry-creation": ["S.wake", "", "i"],
    "keep-waiting": ["S.wake", "", "i"],
    handoff: ["S.wake", "", "i"],
    "stage-change": ["S.wake", "", "i"],
    "dialog-close": ["S.wake", "", "i"],
    "attach-ok": ["S.wake", "", "i"],
    "attach-unsupported": ["S.wake", "", "i"],
    "attach-failed": ["S.wake", "", "i"],
    "agent-ready": ["S.wake", "", "i"],
    "agent-not-ready": ["S.wake", "", "i"],
    prepared: ["S.wake", "", "i"],
    "prepare-failed": ["S.wake", "", "i"],
    "claim-saved": ["S.wake", "", "i"],
    "claim-write-failed": ["S.wake", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["S.wake", "", "u"],
    "receipt-write-failed": ["S.wake", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.wake", "uncertain", "a"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["S.wake", "", "i"],
    "stop-failed": ["S.wake", "", "i"],
    rest: ["S.wake", "poll", "a"],
    awake: ["S.wake", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["S.credits", "poll", "a"],
    unfrozen: ["S.wake", "", "i"],
    settings: ["S.settings", "poll", "a"],
    "settings-repaired": ["S.wake", "", "i"],
    "wake-failed": ["S.wake", "", "i"],
    "null-client": ["Q.wake", "uncertain+poll", "a"],
    "client-restored": ["S.wake", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["S.wake", "", "i"],
    "task-interrupted": ["S.wake", "", "i"],
    "stage-lost": ["S.wake", "", "i"],
    "account-away": ["S.wake", "", "i"],
    "account-back": ["S.host", "poll", "a"],
    reload: ["S.host", "poll", "a"],
    "storage-changed": ["S.host", "poll", "a"],
    "disposition-persisted": ["S.wake", "", "i"],
    "recovery-complete": ["S.wake", "", "i"],
  },
  "Q.none": {
    confirm: ["Q.none", "", "i"],
    cancel: ["Q.none", "", "d"],
    choose: ["Q.none", "", "d"],
    stop: ["Q.none", "", "d"],
    return: ["Q.none", "", "d"],
    retry: ["S.none", "retry+poll+dispatch", "a"],
    "retry-stage": ["Q.none", "", "i"],
    "retry-creation": ["Q.none", "", "i"],
    "keep-waiting": ["Q.none", "", "i"],
    handoff: ["Q.none", "", "i"],
    "stage-change": ["Q.none", "", "i"],
    "dialog-close": ["Q.none", "", "i"],
    "attach-ok": ["Q.none", "", "i"],
    "attach-unsupported": ["Q.none", "", "i"],
    "attach-failed": ["Q.none", "", "i"],
    "agent-ready": ["Q.none", "", "i"],
    "agent-not-ready": ["Q.none", "", "i"],
    prepared: ["Q.none", "", "i"],
    "prepare-failed": ["Q.none", "", "i"],
    "claim-saved": ["Q.none", "", "i"],
    "claim-write-failed": ["Q.none", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["Q.none", "", "u"],
    "receipt-write-failed": ["Q.none", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.none", "", "i"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["Q.none", "", "i"],
    "stop-failed": ["Q.none", "", "i"],
    rest: ["Q.host", "poll", "a"],
    awake: ["Q.none", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["Q.credits", "poll", "a"],
    unfrozen: ["Q.none", "", "i"],
    settings: ["Q.settings", "poll", "a"],
    "settings-repaired": ["Q.none", "", "i"],
    "wake-failed": ["Q.none", "", "i"],
    "null-client": ["Q.client", "uncertain+poll", "a"],
    "client-restored": ["Q.none", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["Q.none", "", "i"],
    "task-interrupted": ["Q.none", "", "i"],
    "stage-lost": ["Q.none", "", "i"],
    "account-away": ["Q.none", "", "i"],
    "account-back": ["Q.host", "poll", "a"],
    reload: ["Q.host", "poll", "a"],
    "storage-changed": ["Q.host", "poll", "a"],
    "disposition-persisted": ["Q.none", "", "i"],
    "recovery-complete": ["Q.none", "", "i"],
  },
  "Q.host": {
    confirm: ["Q.host", "", "i"],
    cancel: ["Q.host", "", "d"],
    choose: ["Q.host", "", "d"],
    stop: ["Q.host", "", "d"],
    return: ["Q.host", "", "d"],
    retry: ["S.none", "retry+poll+dispatch", "a"],
    "retry-stage": ["Q.host", "", "i"],
    "retry-creation": ["Q.host", "", "i"],
    "keep-waiting": ["Q.host", "", "i"],
    handoff: ["Q.host", "", "i"],
    "stage-change": ["Q.host", "", "i"],
    "dialog-close": ["Q.host", "", "i"],
    "attach-ok": ["Q.host", "", "i"],
    "attach-unsupported": ["Q.host", "", "i"],
    "attach-failed": ["Q.host", "", "i"],
    "agent-ready": ["Q.host", "", "i"],
    "agent-not-ready": ["Q.host", "", "i"],
    prepared: ["Q.host", "", "i"],
    "prepare-failed": ["Q.host", "", "i"],
    "claim-saved": ["Q.host", "", "i"],
    "claim-write-failed": ["Q.host", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["Q.host", "", "u"],
    "receipt-write-failed": ["Q.host", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.host", "", "i"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["Q.host", "", "i"],
    "stop-failed": ["Q.host", "", "i"],
    rest: ["Q.host", "poll", "a"],
    awake: ["Q.none", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["Q.credits", "poll", "a"],
    unfrozen: ["Q.host", "", "i"],
    settings: ["Q.settings", "poll", "a"],
    "settings-repaired": ["Q.host", "", "i"],
    "wake-failed": ["Q.host", "", "i"],
    "null-client": ["Q.client", "uncertain+poll", "a"],
    "client-restored": ["Q.host", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["Q.host", "", "i"],
    "task-interrupted": ["Q.host", "", "i"],
    "stage-lost": ["Q.host", "", "i"],
    "account-away": ["Q.host", "", "i"],
    "account-back": ["Q.host", "poll", "a"],
    reload: ["Q.host", "poll", "a"],
    "storage-changed": ["Q.host", "poll", "a"],
    "disposition-persisted": ["Q.host", "", "i"],
    "recovery-complete": ["Q.host", "", "i"],
  },
  "Q.credits": {
    confirm: ["Q.credits", "", "i"],
    cancel: ["Q.credits", "", "d"],
    choose: ["Q.credits", "", "d"],
    stop: ["Q.credits", "", "d"],
    return: ["Q.credits", "", "d"],
    retry: ["S.credits", "retry+poll", "a"],
    "retry-stage": ["Q.credits", "", "i"],
    "retry-creation": ["Q.credits", "", "i"],
    "keep-waiting": ["Q.credits", "", "i"],
    handoff: ["Q.credits", "", "i"],
    "stage-change": ["Q.credits", "", "i"],
    "dialog-close": ["Q.credits", "", "i"],
    "attach-ok": ["Q.credits", "", "i"],
    "attach-unsupported": ["Q.credits", "", "i"],
    "attach-failed": ["Q.credits", "", "i"],
    "agent-ready": ["Q.credits", "", "i"],
    "agent-not-ready": ["Q.credits", "", "i"],
    prepared: ["Q.credits", "", "i"],
    "prepare-failed": ["Q.credits", "", "i"],
    "claim-saved": ["Q.credits", "", "i"],
    "claim-write-failed": ["Q.credits", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["Q.credits", "", "u"],
    "receipt-write-failed": ["Q.credits", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.credits", "", "i"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["Q.credits", "", "i"],
    "stop-failed": ["Q.credits", "", "i"],
    rest: ["Q.credits", "poll", "a"],
    awake: ["Q.credits", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["Q.credits", "poll", "a"],
    unfrozen: ["Q.none", "poll", "a"],
    settings: ["Q.credits", "poll", "a"],
    "settings-repaired": ["Q.credits", "", "i"],
    "wake-failed": ["Q.credits", "", "i"],
    "null-client": ["Q.credits", "poll", "a"],
    "client-restored": ["Q.credits", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["Q.credits", "", "i"],
    "task-interrupted": ["Q.credits", "", "i"],
    "stage-lost": ["Q.credits", "", "i"],
    "account-away": ["Q.credits", "", "i"],
    "account-back": ["Q.host", "poll", "a"],
    reload: ["Q.host", "poll", "a"],
    "storage-changed": ["Q.host", "poll", "a"],
    "disposition-persisted": ["Q.credits", "", "i"],
    "recovery-complete": ["Q.credits", "", "i"],
  },
  "Q.settings": {
    confirm: ["Q.settings", "", "i"],
    cancel: ["Q.settings", "", "d"],
    choose: ["Q.settings", "", "d"],
    stop: ["Q.settings", "", "d"],
    return: ["Q.settings", "", "d"],
    retry: ["S.settings", "retry+poll", "a"],
    "retry-stage": ["Q.settings", "", "i"],
    "retry-creation": ["Q.settings", "", "i"],
    "keep-waiting": ["Q.settings", "", "i"],
    handoff: ["Q.settings", "", "i"],
    "stage-change": ["Q.settings", "", "i"],
    "dialog-close": ["Q.settings", "", "i"],
    "attach-ok": ["Q.settings", "", "i"],
    "attach-unsupported": ["Q.settings", "", "i"],
    "attach-failed": ["Q.settings", "", "i"],
    "agent-ready": ["Q.settings", "", "i"],
    "agent-not-ready": ["Q.settings", "", "i"],
    prepared: ["Q.settings", "", "i"],
    "prepare-failed": ["Q.settings", "", "i"],
    "claim-saved": ["Q.settings", "", "i"],
    "claim-write-failed": ["Q.settings", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["Q.settings", "", "u"],
    "receipt-write-failed": ["Q.settings", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.settings", "", "i"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["Q.settings", "", "i"],
    "stop-failed": ["Q.settings", "", "i"],
    rest: ["Q.settings", "poll", "a"],
    awake: ["Q.settings", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["Q.credits", "poll", "a"],
    unfrozen: ["Q.settings", "", "i"],
    settings: ["Q.settings", "poll", "a"],
    "settings-repaired": ["Q.none", "poll", "a"],
    "wake-failed": ["Q.settings", "", "i"],
    "null-client": ["Q.settings", "poll", "a"],
    "client-restored": ["Q.settings", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["Q.settings", "", "i"],
    "task-interrupted": ["Q.settings", "", "i"],
    "stage-lost": ["Q.settings", "", "i"],
    "account-away": ["Q.settings", "", "i"],
    "account-back": ["Q.host", "poll", "a"],
    reload: ["Q.host", "poll", "a"],
    "storage-changed": ["Q.host", "poll", "a"],
    "disposition-persisted": ["Q.settings", "", "i"],
    "recovery-complete": ["Q.settings", "", "i"],
  },
  "Q.client": {
    confirm: ["Q.client", "", "i"],
    cancel: ["Q.client", "", "d"],
    choose: ["Q.client", "", "d"],
    stop: ["Q.client", "", "d"],
    return: ["Q.client", "", "d"],
    retry: ["Q.client", "retry+uncertain+poll", "a"],
    "retry-stage": ["Q.client", "", "i"],
    "retry-creation": ["Q.client", "", "i"],
    "keep-waiting": ["Q.client", "", "i"],
    handoff: ["Q.client", "", "i"],
    "stage-change": ["Q.client", "", "i"],
    "dialog-close": ["Q.client", "", "i"],
    "attach-ok": ["Q.client", "", "i"],
    "attach-unsupported": ["Q.client", "", "i"],
    "attach-failed": ["Q.client", "", "i"],
    "agent-ready": ["Q.client", "", "i"],
    "agent-not-ready": ["Q.client", "", "i"],
    prepared: ["Q.client", "", "i"],
    "prepare-failed": ["Q.client", "", "i"],
    "claim-saved": ["Q.client", "", "i"],
    "claim-write-failed": ["Q.client", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["Q.client", "", "u"],
    "receipt-write-failed": ["Q.client", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.client", "", "i"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["Q.client", "", "i"],
    "stop-failed": ["Q.client", "", "i"],
    rest: ["Q.client", "poll", "a"],
    awake: ["Q.client", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["Q.credits", "poll", "a"],
    unfrozen: ["Q.client", "", "i"],
    settings: ["Q.settings", "poll", "a"],
    "settings-repaired": ["Q.client", "", "i"],
    "wake-failed": ["Q.client", "", "i"],
    "null-client": ["Q.client", "poll", "a"],
    "client-restored": ["Q.none", "poll", "a"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["Q.client", "", "i"],
    "task-interrupted": ["Q.client", "", "i"],
    "stage-lost": ["Q.client", "", "i"],
    "account-away": ["Q.client", "", "i"],
    "account-back": ["Q.host", "poll", "a"],
    reload: ["Q.host", "poll", "a"],
    "storage-changed": ["Q.host", "poll", "a"],
    "disposition-persisted": ["Q.client", "", "i"],
    "recovery-complete": ["Q.client", "", "i"],
  },
  "Q.wake": {
    confirm: ["Q.wake", "", "i"],
    cancel: ["Q.wake", "", "d"],
    choose: ["Q.wake", "", "d"],
    stop: ["Q.wake", "", "d"],
    return: ["Q.wake", "", "d"],
    retry: ["S.none", "retry+poll+dispatch", "a"],
    "retry-stage": ["Q.wake", "", "i"],
    "retry-creation": ["Q.wake", "", "i"],
    "keep-waiting": ["Q.wake", "", "i"],
    handoff: ["Q.wake", "", "i"],
    "stage-change": ["Q.wake", "", "i"],
    "dialog-close": ["Q.wake", "", "i"],
    "attach-ok": ["Q.wake", "", "i"],
    "attach-unsupported": ["Q.wake", "", "i"],
    "attach-failed": ["Q.wake", "", "i"],
    "agent-ready": ["Q.wake", "", "i"],
    "agent-not-ready": ["Q.wake", "", "i"],
    prepared: ["Q.wake", "", "i"],
    "prepare-failed": ["Q.wake", "", "i"],
    "claim-saved": ["Q.wake", "", "i"],
    "claim-write-failed": ["Q.wake", "", "i"],
    "host-accept": ["A", "record-receipt", "a"],
    "receipt-saved": ["Q.wake", "", "u"],
    "receipt-write-failed": ["Q.wake", "", "u"],
    "known-refusal": ["W.notsent", "known-refusal+report-not-sent", "a"],
    "transport-fail": ["Q.wake", "", "i"],
    "late-accept": ["A", "record-receipt", "a"],
    "stop-result": ["Q.wake", "", "i"],
    "stop-failed": ["Q.wake", "", "i"],
    rest: ["Q.wake", "poll", "a"],
    awake: ["Q.wake", "poll", "a"],
    "terminal-row": ["E", "end-host", "a"],
    frozen: ["Q.credits", "poll", "a"],
    unfrozen: ["Q.wake", "", "i"],
    settings: ["Q.settings", "poll", "a"],
    "settings-repaired": ["Q.wake", "", "i"],
    "wake-failed": ["Q.wake", "", "i"],
    "null-client": ["Q.wake", "poll", "a"],
    "client-restored": ["Q.wake", "", "i"],
    "access-lost": ["E", "end-host", "a"],
    "task-deleted": ["E", "end-host", "a"],
    "epic-create-failed": ["Q.wake", "", "i"],
    "task-interrupted": ["Q.wake", "", "i"],
    "stage-lost": ["Q.wake", "", "i"],
    "account-away": ["Q.wake", "", "i"],
    "account-back": ["Q.host", "poll", "a"],
    reload: ["Q.host", "poll", "a"],
    "storage-changed": ["Q.host", "poll", "a"],
    "disposition-persisted": ["Q.wake", "", "i"],
    "recovery-complete": ["Q.wake", "", "i"],
  },
  A: {
    confirm: ["A", "", "i"],
    cancel: ["A", "", "d"],
    choose: ["A", "", "d"],
    stop: ["A", "", "d"],
    return: ["A", "", "d"],
    retry: ["A", "", "i"],
    "retry-stage": ["A", "", "i"],
    "retry-creation": ["A", "", "i"],
    "keep-waiting": ["A", "", "i"],
    handoff: ["A", "", "i"],
    "stage-change": ["A", "", "i"],
    "dialog-close": ["A", "", "i"],
    "attach-ok": ["A", "", "i"],
    "attach-unsupported": ["A", "", "i"],
    "attach-failed": ["A", "", "i"],
    "agent-ready": ["A", "", "i"],
    "agent-not-ready": ["A", "", "i"],
    prepared: ["A", "", "i"],
    "prepare-failed": ["A", "", "i"],
    "claim-saved": ["A", "", "i"],
    "claim-write-failed": ["A", "", "i"],
    "host-accept": ["A", "", "i"],
    "receipt-saved": ["D", "finish-ui", "a"],
    "receipt-write-failed": ["Q.none", "uncertain", "a"],
    "known-refusal": ["A", "", "i"],
    "transport-fail": ["A", "", "i"],
    "late-accept": ["A", "", "i"],
    "stop-result": ["A", "", "i"],
    "stop-failed": ["A", "", "i"],
    rest: ["A", "", "i"],
    awake: ["A", "", "i"],
    "terminal-row": ["A", "", "i"],
    frozen: ["A", "", "i"],
    unfrozen: ["A", "", "i"],
    settings: ["A", "", "i"],
    "settings-repaired": ["A", "", "i"],
    "wake-failed": ["A", "", "i"],
    "null-client": ["A", "", "i"],
    "client-restored": ["A", "", "i"],
    "access-lost": ["A", "", "i"],
    "task-deleted": ["A", "", "i"],
    "epic-create-failed": ["A", "", "i"],
    "task-interrupted": ["A", "", "i"],
    "stage-lost": ["A", "", "i"],
    "account-away": ["A", "", "i"],
    "account-back": ["A", "", "i"],
    reload: ["A", "", "i"],
    "storage-changed": ["A", "", "i"],
    "disposition-persisted": ["A", "", "i"],
    "recovery-complete": ["A", "", "i"],
  },
  E: {
    confirm: ["E", "", "i"],
    cancel: ["RC", "ret+remove", "a"],
    choose: ["RC", "ret+remove", "a"],
    stop: ["RC", "ret+remove", "a"],
    return: ["RC", "ret+remove", "a"],
    retry: ["RC", "ret+remove", "a"],
    "retry-stage": ["E", "", "i"],
    "retry-creation": ["E", "", "i"],
    "keep-waiting": ["E", "", "i"],
    handoff: ["E", "", "i"],
    "stage-change": ["E", "", "i"],
    "dialog-close": ["E", "", "i"],
    "attach-ok": ["E", "", "i"],
    "attach-unsupported": ["E", "", "i"],
    "attach-failed": ["E", "", "i"],
    "agent-ready": ["E", "", "i"],
    "agent-not-ready": ["E", "", "i"],
    prepared: ["E", "", "i"],
    "prepare-failed": ["E", "", "i"],
    "claim-saved": ["E", "", "i"],
    "claim-write-failed": ["E", "", "i"],
    "host-accept": ["E", "", "i"],
    "receipt-saved": ["E", "", "i"],
    "receipt-write-failed": ["E", "", "i"],
    "known-refusal": ["E", "", "i"],
    "transport-fail": ["E", "", "i"],
    "late-accept": ["E", "", "i"],
    "stop-result": ["E", "", "i"],
    "stop-failed": ["E", "", "i"],
    rest: ["E", "", "i"],
    awake: ["E", "", "i"],
    "terminal-row": ["RC", "ret+remove", "a"],
    frozen: ["E", "", "i"],
    unfrozen: ["E", "", "i"],
    settings: ["E", "", "i"],
    "settings-repaired": ["E", "", "i"],
    "wake-failed": ["E", "", "i"],
    "null-client": ["E", "", "i"],
    "client-restored": ["E", "", "i"],
    "access-lost": ["E", "", "i"],
    "task-deleted": ["E", "", "i"],
    "epic-create-failed": ["E", "", "i"],
    "task-interrupted": ["E", "", "i"],
    "stage-lost": ["E", "", "i"],
    "account-away": ["E", "", "i"],
    "account-back": ["RC", "ret+remove", "a"],
    reload: ["RC", "ret+remove", "a"],
    "storage-changed": ["RC", "ret+remove", "a"],
    "disposition-persisted": ["RC", "ret+remove", "a"],
    "recovery-complete": ["RC", "remove", "a"],
  },
  D: {
    confirm: ["D", "", "i"],
    cancel: ["D", "", "i"],
    choose: ["D", "", "i"],
    stop: ["D", "", "i"],
    return: ["D", "", "i"],
    retry: ["D", "", "i"],
    "retry-stage": ["D", "", "i"],
    "retry-creation": ["D", "", "i"],
    "keep-waiting": ["D", "", "i"],
    handoff: ["D", "", "i"],
    "stage-change": ["D", "", "i"],
    "dialog-close": ["D", "", "i"],
    "attach-ok": ["D", "", "i"],
    "attach-unsupported": ["D", "", "i"],
    "attach-failed": ["D", "", "i"],
    "agent-ready": ["D", "", "i"],
    "agent-not-ready": ["D", "", "i"],
    prepared: ["D", "", "i"],
    "prepare-failed": ["D", "", "i"],
    "claim-saved": ["D", "", "i"],
    "claim-write-failed": ["D", "", "i"],
    "host-accept": ["D", "", "i"],
    "receipt-saved": ["D", "", "i"],
    "receipt-write-failed": ["D", "", "i"],
    "known-refusal": ["D", "", "i"],
    "transport-fail": ["D", "", "i"],
    "late-accept": ["D", "", "i"],
    "stop-result": ["D", "", "i"],
    "stop-failed": ["D", "", "i"],
    rest: ["D", "", "i"],
    awake: ["D", "", "i"],
    "terminal-row": ["D", "", "i"],
    frozen: ["D", "", "i"],
    unfrozen: ["D", "", "i"],
    settings: ["D", "", "i"],
    "settings-repaired": ["D", "", "i"],
    "wake-failed": ["D", "", "i"],
    "null-client": ["D", "", "i"],
    "client-restored": ["D", "", "i"],
    "access-lost": ["D", "", "i"],
    "task-deleted": ["D", "", "i"],
    "epic-create-failed": ["D", "", "i"],
    "task-interrupted": ["D", "", "i"],
    "stage-lost": ["D", "", "i"],
    "account-away": ["D", "remove", "a"],
    "account-back": ["D", "", "i"],
    reload: ["D", "", "i"],
    "storage-changed": ["D", "", "i"],
    "disposition-persisted": ["D", "", "i"],
    "recovery-complete": ["D", "", "i"],
  },
  C: {
    confirm: ["C", "", "i"],
    cancel: ["C", "", "i"],
    choose: ["C", "", "i"],
    stop: ["C", "", "i"],
    return: ["C", "", "i"],
    retry: ["C", "", "i"],
    "retry-stage": ["C", "", "i"],
    "retry-creation": ["C", "", "i"],
    "keep-waiting": ["C", "", "i"],
    handoff: ["C", "", "i"],
    "stage-change": ["C", "", "i"],
    "dialog-close": ["C", "", "i"],
    "attach-ok": ["C", "", "i"],
    "attach-unsupported": ["C", "", "i"],
    "attach-failed": ["C", "", "i"],
    "agent-ready": ["C", "", "i"],
    "agent-not-ready": ["C", "", "i"],
    prepared: ["C", "", "i"],
    "prepare-failed": ["C", "", "i"],
    "claim-saved": ["C", "", "i"],
    "claim-write-failed": ["C", "", "i"],
    "host-accept": ["C", "", "i"],
    "receipt-saved": ["C", "", "i"],
    "receipt-write-failed": ["C", "", "i"],
    "known-refusal": ["C", "", "i"],
    "transport-fail": ["C", "", "i"],
    "late-accept": ["C", "", "i"],
    "stop-result": ["C", "", "i"],
    "stop-failed": ["C", "", "i"],
    rest: ["C", "", "i"],
    awake: ["C", "", "i"],
    "terminal-row": ["C", "", "i"],
    frozen: ["C", "", "i"],
    unfrozen: ["C", "", "i"],
    settings: ["C", "", "i"],
    "settings-repaired": ["C", "", "i"],
    "wake-failed": ["C", "", "i"],
    "null-client": ["C", "", "i"],
    "client-restored": ["C", "", "i"],
    "access-lost": ["C", "", "i"],
    "task-deleted": ["C", "", "i"],
    "epic-create-failed": ["C", "", "i"],
    "task-interrupted": ["C", "", "i"],
    "stage-lost": ["C", "", "i"],
    "account-away": ["C", "", "i"],
    "account-back": ["C", "", "i"],
    reload: ["C", "", "i"],
    "storage-changed": ["C", "", "i"],
    "disposition-persisted": ["C", "", "i"],
    "recovery-complete": ["C", "", "i"],
  },
  R: {
    confirm: ["R", "", "i"],
    cancel: ["R", "", "i"],
    choose: ["R", "", "i"],
    stop: ["R", "", "i"],
    return: ["R", "", "i"],
    retry: ["R", "", "i"],
    "retry-stage": ["R", "", "i"],
    "retry-creation": ["R", "", "i"],
    "keep-waiting": ["R", "", "i"],
    handoff: ["R", "", "i"],
    "stage-change": ["R", "", "i"],
    "dialog-close": ["R", "", "i"],
    "attach-ok": ["R", "", "i"],
    "attach-unsupported": ["R", "", "i"],
    "attach-failed": ["R", "", "i"],
    "agent-ready": ["R", "", "i"],
    "agent-not-ready": ["R", "", "i"],
    prepared: ["R", "", "i"],
    "prepare-failed": ["R", "", "i"],
    "claim-saved": ["R", "", "i"],
    "claim-write-failed": ["R", "", "i"],
    "host-accept": ["R", "", "i"],
    "receipt-saved": ["R", "", "i"],
    "receipt-write-failed": ["R", "", "i"],
    "known-refusal": ["R", "", "i"],
    "transport-fail": ["R", "", "i"],
    "late-accept": ["R", "", "i"],
    "stop-result": ["R", "", "i"],
    "stop-failed": ["R", "", "i"],
    rest: ["R", "", "i"],
    awake: ["R", "", "i"],
    "terminal-row": ["R", "", "i"],
    frozen: ["R", "", "i"],
    unfrozen: ["R", "", "i"],
    settings: ["R", "", "i"],
    "settings-repaired": ["R", "", "i"],
    "wake-failed": ["R", "", "i"],
    "null-client": ["R", "", "i"],
    "client-restored": ["R", "", "i"],
    "access-lost": ["R", "", "i"],
    "task-deleted": ["R", "", "i"],
    "epic-create-failed": ["R", "", "i"],
    "task-interrupted": ["R", "", "i"],
    "stage-lost": ["R", "", "i"],
    "account-away": ["R", "", "i"],
    "account-back": ["R", "", "i"],
    reload: ["R", "", "i"],
    "storage-changed": ["R", "", "i"],
    "disposition-persisted": ["R", "", "i"],
    "recovery-complete": ["R", "", "i"],
  },
};

const OUTCOME: Readonly<Record<Cell[2], Outcome>> = {
  a: "applied",
  i: "ignored",
  d: "denied-claim",
  u: "unreachable",
};

const CLAIMED_PHASES = new Set(["sending", "uncertain", "accepted"]);

function rowById(id: string): Row {
  const row = ROWS.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`unknown matrix row ${id}`);
  return row;
}

function stateOf(kind: Kind, rowId: string): PendingSendState {
  const row = rowById(rowId);
  return {
    kind,
    // The engine's phase and blocker unions are the contract's names.
    phase: row.phase as PendingSendPhase,
    blocker: row.blocker as PendingSendBlocker,
  };
}

function defaultFacts(rowId: string): PendingSendFacts {
  const row = rowById(rowId);
  return {
    current: true,
    accountActive: true,
    owns: true,
    exclusive: true,
    origin: true,
    durableClaim: CLAIMED_PHASES.has(row.phase),
    host: "unknown",
    frozen: false,
    settingsReady: true,
    clientReady: rowId !== "Q.client",
    agentReady: true,
    modelReady: rowId !== "W.model",
    modelUnavailable: false,
    stageCurrent: true,
    inFlight: false,
    attachPending: false,
    wakeInFlight: false,
    epicConfirmed: true,
    stageStatus: "handoff",
    terminalDisposition: false,
    stopRequested: false,
    sandboxKnown: true,
    retryAction: "send-again",
    retryObservation: "observe",
    observation: { kind: "none" },
  };
}

/** Retry re-reads a live claim against a usable host; a pre-claim retry waits for one. */
function factsFor(rowId: string, event: string): PendingSendFacts {
  const row = rowById(rowId);
  let overlay: Partial<PendingSendFacts> = OVERLAY[event] ?? {};
  if (event === "retry") {
    overlay = row.phase === "waiting" ? {} : { host: "awake" };
  }
  const extra: Partial<PendingSendFacts> =
    event === "claim-saved" ? { durableClaim: true } : {};
  return { ...defaultFacts(rowId), ...overlay, ...extra };
}

function run(
  state: PendingSendState,
  event: string,
  facts: PendingSendFacts,
): PendingSendTransition {
  // The matrix names events beyond the engine's current union; the engine
  // must accept every one.
  return transitionPendingSend(state, event as PendingSendEvent, facts);
}

function outcomeOf(transition: PendingSendTransition): unknown {
  return "outcome" in transition ? transition.outcome : undefined;
}

function resolveRow(kind: Kind, token: string): string {
  if (token !== "RC") return token;
  return kind === "chat" ? "R" : "C";
}

function expectedEffects(kind: Kind, joined: string): string[] {
  return joined
    .split("+")
    .filter((name) => name.length > 0)
    .map((name) => (name === "ret" ? "return-message" : name))
    .filter((name) => name !== "return-message" || kind === "chat")
    .sort();
}

function sortedEffects(transition: PendingSendTransition): string[] {
  return [...transition.effects].sort();
}

describe.each(["chat", "fork"] as const)("pending send matrix (%s)", (kind) => {
  for (const row of ROWS) {
    describe(`from ${row.id}`, () => {
      for (const event of EVENTS) {
        const cell = GRID[row.id][event];
        it(`PS.${row.id}.${event}`, () => {
          const start = stateOf(kind, row.id);
          const transition = run(start, event, factsFor(row.id, event));
          const next = stateOf(kind, resolveRow(kind, cell[0]));
          expect({
            phase: transition.state.phase,
            blocker: transition.state.blocker,
            effects: sortedEffects(transition),
            outcome: outcomeOf(transition),
          }).toEqual({
            phase: next.phase,
            blocker: next.blocker,
            effects: expectedEffects(kind, cell[1]),
            outcome: OUTCOME[cell[2]],
          });
          expect(transition.state.kind).toBe(kind);
        });
      }
    });
  }
});

/** What a late or foreign input may still do on the original account. */
const DURABLE_BOOKKEEPING = new Set([
  "host-accept",
  "late-accept",
  "receipt-saved",
  "receipt-write-failed",
  "known-refusal",
  "transport-fail",
  "account-away",
]);

function bookkeepingExpectation(
  rowId: string,
  event: string,
): {
  readonly phase: string;
  readonly blocker: string;
  readonly effects: string[];
} | null {
  const row = rowById(rowId);
  if (
    (event === "host-accept" || event === "late-accept") &&
    (row.phase === "sending" || row.phase === "uncertain")
  ) {
    return { phase: "accepted", blocker: "none", effects: ["record-receipt"] };
  }
  if (
    event === "known-refusal" &&
    (row.phase === "sending" || row.phase === "uncertain")
  ) {
    return {
      phase: "waiting",
      blocker: "not-sent",
      effects: ["known-refusal"],
    };
  }
  if (event === "transport-fail" && row.phase === "sending") {
    return { phase: "uncertain", blocker: row.blocker, effects: ["uncertain"] };
  }
  if (row.id === "D" && event === "account-away") {
    // Signing out clears delivered receipts; it is account cleanup, not a late RPC.
    return { phase: "delivered", blocker: "none", effects: ["remove"] };
  }
  if (row.id === "A" && event === "receipt-saved") {
    return { phase: "delivered", blocker: "none", effects: [] };
  }
  if (row.id === "A" && event === "receipt-write-failed") {
    return { phase: "uncertain", blocker: "none", effects: ["uncertain"] };
  }
  return null;
}

const ALL_CELLS = ROWS.flatMap((row) =>
  EVENTS.map((event) => [row.id, event] as const),
);

describe("guard: another account is active", () => {
  it.each(ALL_CELLS)(
    "PS.%s.%s changes nothing but the original owner's durable receipt",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        accountActive: false,
      });
      const bookkeeping = DURABLE_BOOKKEEPING.has(event)
        ? bookkeepingExpectation(rowId, event)
        : null;
      expect({
        phase: transition.state.phase,
        blocker: transition.state.blocker,
        effects: sortedEffects(transition),
      }).toEqual(
        bookkeeping ?? {
          phase: start.phase,
          blocker: start.blocker,
          effects: [],
        },
      );
    },
  );
});

describe("guard: the durable claim is not the current record", () => {
  it.each(ALL_CELLS)(
    "PS.%s.%s is rejected with no effect, including a late host response",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        current: false,
      });
      expect(transition.effects).toEqual([]);
      expect(transition.state).toEqual(start);
    },
  );
});

describe("guard: this window does not own the send", () => {
  const WORLD_EFFECTS = [
    "wake",
    "dispatch",
    "end-host",
    "prepare",
    "persist-claim",
    "return-message",
    "remove",
    "stop-host",
    "handoff",
    "confirm-epic",
  ];
  it.each(ALL_CELLS)(
    "PS.%s.%s reaches nothing outside the window",
    (rowId, event) => {
      const transition = run(stateOf("chat", rowId), event, {
        ...factsFor(rowId, event),
        owns: false,
      });
      const bookkeeping = DURABLE_BOOKKEEPING.has(event)
        ? bookkeepingExpectation(rowId, event)
        : null;
      if (bookkeeping !== null) {
        expect({
          phase: transition.state.phase,
          blocker: transition.state.blocker,
          effects: sortedEffects(transition),
        }).toEqual(bookkeeping);
        return;
      }
      expect(
        transition.effects.filter((effect) => WORLD_EFFECTS.includes(effect)),
      ).toEqual([]);
    },
  );
});

describe("guard: withdrawal needs a native lock or the origin window", () => {
  const WITHDRAWALS = ["cancel", "choose", "stop", "return"] as const;
  const PRECLAIM = ROWS.filter(
    (row) => row.phase === "unconfirmed" || row.phase === "waiting",
  ).map((row) => row.id);

  it.each(
    PRECLAIM.flatMap((id) => WITHDRAWALS.map((event) => [id, event] as const)),
  )("PS.%s.%s is refused with neither lock nor origin", (rowId, event) => {
    const start = stateOf("chat", rowId);
    const transition = run(start, event, {
      ...factsFor(rowId, event),
      exclusive: false,
      origin: false,
    });
    expect(transition.effects).toEqual([]);
    expect(transition.state).toEqual(start);
    expect(outcomeOf(transition)).toBe("denied-ownership");
    expect(transition.view.canWithdraw).toBe(false);
  });

  it.each(WITHDRAWALS)(
    "PS.U.%s is allowed from the origin window alone, and a confirmed send is not",
    (event) => {
      const origin = run(stateOf("chat", "U"), event, {
        ...factsFor("U", event),
        exclusive: false,
        origin: true,
      });
      expect(origin.state.phase).toBe("returned");
      const confirmed = run(stateOf("chat", "W.host"), event, {
        ...factsFor("W.host", event),
        exclusive: false,
        origin: true,
      });
      expect(confirmed.effects).toEqual([]);
      expect(confirmed.state.phase).toBe("waiting");
    },
  );

  it.each(WITHDRAWALS)(
    "PS.E.%s still completes a stored terminal disposition without any lock",
    (event) => {
      const transition = run(stateOf("chat", "E"), event, {
        ...factsFor("E", event),
        exclusive: false,
        origin: false,
      });
      expect(transition.state.phase).toBe("returned");
      expect(transition.effects).toContain("return-message");
    },
  );
});

describe("guard: an unowned window reports a live claim to a withdrawal", () => {
  const WITHDRAWALS = ["cancel", "choose", "stop", "return"] as const;
  const CLAIMED = ROWS.filter(
    (row) => row.phase === "sending" || row.phase === "uncertain",
  ).map((row) => row.id);

  it.each(
    CLAIMED.flatMap((id) => WITHDRAWALS.map((event) => [id, event] as const)),
  )(
    "PS.%s.%s is denied-claim with no effect on the active account without ownership",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        owns: false,
        exclusive: false,
        origin: false,
        durableClaim: true,
      });
      expect(outcomeOf(transition)).toBe("denied-claim");
      expect(transition.state).toEqual(start);
      expect(transition.effects).toEqual([]);
    },
  );

  it.each(
    CLAIMED.flatMap((id) => WITHDRAWALS.map((event) => [id, event] as const)),
  )("PS.%s.%s stays denied-ownership under another account", (rowId, event) => {
    const start = stateOf("chat", rowId);
    const transition = run(start, event, {
      ...factsFor(rowId, event),
      accountActive: false,
      owns: false,
      durableClaim: true,
    });
    expect(outcomeOf(transition)).toBe("denied-ownership");
    expect(transition.state).toEqual(start);
    expect(transition.effects).toEqual([]);
  });
});

describe("guard: model availability is the last readiness fact", () => {
  const READY: Partial<PendingSendFacts> = {
    host: "awake",
    agentReady: true,
    modelReady: false,
  };
  /** Every fact that outranks the model, each leaving the host otherwise ready. */
  const OUTRANKING: ReadonlyArray<
    readonly [string, Partial<PendingSendFacts>]
  > = [
    ["an ended sandbox", { host: "ended" }],
    ["a frozen sandbox", { frozen: true }],
    ["unapplied settings", { settingsReady: false }],
    ["a stage that is only staged", { stageStatus: "staged" }],
    ["a stage still creating", { stageStatus: "creating" }],
    ["a resting sandbox", { host: "resting" }],
    ["a missing client", { clientReady: false }],
    ["an agent that is not ready", { agentReady: false }],
  ];
  const STARTS = ["W.none", "W.model"] as const;
  const observe = (
    rowId: string,
    event: string,
    overlay: Partial<PendingSendFacts>,
  ): PendingSendTransition =>
    run(stateOf("chat", rowId), event, {
      ...defaultFacts(rowId),
      ...READY,
      ...overlay,
    });

  it.each(
    STARTS.flatMap((start) =>
      OUTRANKING.map(([label, facts]) => [start, label, facts] as const),
    ),
  )(
    "from %s an unavailable model changes nothing under %s",
    (start, _label, outranking) => {
      const known = observe(start, "observe", {
        ...outranking,
        modelUnavailable: false,
      });
      const unavailable = observe(start, "observe", {
        ...outranking,
        modelUnavailable: true,
      });
      expect(unavailable.state).toEqual(known.state);
      expect(sortedEffects(unavailable)).toEqual(sortedEffects(known));
      expect(outcomeOf(unavailable)).toEqual(outcomeOf(known));
    },
  );

  it.each(STARTS)(
    "from %s a ready host still reading its model fetches it and polls",
    (start) => {
      const transition = observe(start, "observe", { modelUnavailable: false });
      expect(transition.state).toEqual({
        kind: "chat",
        phase: "waiting",
        blocker: "model",
      });
      expect(sortedEffects(transition)).toEqual(["fetch-model", "poll"]);
    },
  );

  it.each(STARTS)(
    "from %s a ready host with no model to send reaches Not sent and keeps polling",
    (start) => {
      const transition = observe(start, "observe", { modelUnavailable: true });
      expect(transition.state).toEqual({
        kind: "chat",
        phase: "waiting",
        blocker: "not-sent",
      });
      expect(sortedEffects(transition)).toEqual(["poll", "report-not-sent"]);
    },
  );

  it.each(STARTS)(
    "from %s a resolved model is never reported unavailable",
    (start) => {
      const resolved = observe(start, "observe", {
        modelReady: true,
        modelUnavailable: true,
      });
      expect(sortedEffects(resolved)).not.toContain("report-not-sent");
      expect(sortedEffects(resolved)).not.toContain("fetch-model");
    },
  );

  it("Retry on a latched Not sent fetches the model again instead of trusting the old negative answer", () => {
    const retry = observe("W.notsent", "retry", { modelUnavailable: true });
    expect(sortedEffects(retry)).toContain("fetch-model");
    expect(sortedEffects(retry)).not.toContain("report-not-sent");
    expect(retry.state.phase).toBe("waiting");
  });

  it.each(OUTRANKING)(
    "Retry on a latched Not sent does not fetch the model under %s",
    (_label, outranking) => {
      const retry = observe("W.notsent", "retry", {
        ...outranking,
        modelUnavailable: true,
      });
      expect(sortedEffects(retry)).not.toContain("fetch-model");
    },
  );

  it("Retry on a latched Not sent whose model is already resolved fetches nothing", () => {
    const retry = observe("W.notsent", "retry", {
      modelReady: true,
      modelUnavailable: true,
    });
    expect(sortedEffects(retry)).not.toContain("fetch-model");
  });
});

describe("guard: a requested stop is held until the host answers", () => {
  const KINDS = ["chat", "fork"] as const;
  const WAITING = ROWS.filter((row) => row.phase === "waiting").map(
    (row) => row.id,
  );
  const released = (kind: Kind) => ({
    kind,
    phase: kind === "chat" ? "returned" : "cancelled",
    blocker: "none",
  });

  it.each(
    KINDS.flatMap((kind) =>
      (["resting", "ended"] as const).map((host) => [kind, host] as const),
    ),
  )(
    "a %s stop answered with the sandbox %s releases the send",
    (kind, host) => {
      const transition = run(stateOf(kind, "W.stop"), "stop-result", {
        ...defaultFacts("W.stop"),
        host,
      });
      expect(transition.state).toEqual(released(kind));
      expect(sortedEffects(transition)).toEqual(
        expectedEffects(kind, "ret+remove"),
      );
    },
  );

  it.each(["awake", "waking", "unknown"] as const)(
    "a stop answered with the sandbox %s keeps the latch and keeps polling",
    (host) => {
      const start = stateOf("chat", "W.stop");
      const transition = run(start, "stop-result", {
        ...defaultFacts("W.stop"),
        host,
      });
      expect(transition.state).toEqual(start);
      expect(sortedEffects(transition)).toEqual(["poll"]);
    },
  );

  it.each(WAITING)(
    "PS.%s.stop while a stop is already in flight requests nothing new and only polls",
    (rowId) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, "stop", {
        ...factsFor(rowId, "stop"),
        inFlight: true,
      });
      // No new stop was authorized: the blocker is whatever it already was.
      expect(transition.state).toEqual(start);
      expect(sortedEffects(transition)).toEqual(["poll"]);
    },
  );

  it.each(WAITING.filter((id) => id !== "W.stop"))(
    "PS.%s.stop holds the latch and requests the stop, returning nothing yet",
    (rowId) => {
      const transition = run(
        stateOf("chat", rowId),
        "stop",
        factsFor(rowId, "stop"),
      );
      expect(sortedEffects(transition)).toEqual(["hold-stop", "stop-host"]);
      expect(transition.state.blocker).toBe("stop");
    },
  );

  const REPAIRS = [
    "agent-ready",
    "agent-not-ready",
    "awake",
    "unfrozen",
    "settings-repaired",
    "client-restored",
    "null-client",
    "reload",
    "storage-changed",
    "account-back",
  ] as const;
  it.each(REPAIRS)(
    "%s while a stop is pending never prepares, wakes, fetches or dispatches",
    (event) => {
      const transition = run(
        stateOf("chat", "W.stop"),
        event,
        factsFor("W.stop", event),
      );
      expect(transition.state.blocker).toBe("stop");
      expect(
        transition.effects.filter((effect) =>
          [
            "prepare",
            "wake",
            "fetch-model",
            "dispatch",
            "persist-claim",
          ].includes(effect),
        ),
      ).toEqual([]);
    },
  );

  it("a failed stop keeps the latch and keeps polling", () => {
    const start = stateOf("chat", "W.stop");
    const transition = run(start, "stop-failed", defaultFacts("W.stop"));
    expect(transition.state).toEqual(start);
    expect(sortedEffects(transition)).toEqual(["poll"]);
  });
});

describe("guard: a Retry requested in a window that may not own the send", () => {
  const LATCHED = ["W.credits", "W.settings", "W.notsent", "W.wake"] as const;
  const OTHERS = ROWS.filter(
    (row) => !(LATCHED as readonly string[]).includes(row.id),
  ).map((row) => row.id);
  const request = (rowId: string, overlay: Partial<PendingSendFacts>) =>
    run(stateOf("chat", rowId), "request-retry", {
      ...defaultFacts(rowId),
      ...overlay,
    });

  it.each(
    LATCHED.flatMap((id) =>
      [
        ["the owner", { owns: true }],
        [
          "a window that does not own the send",
          { owns: false, exclusive: false, origin: false },
        ],
      ].map(([who, facts]) => [id, who, facts] as const),
    ),
  )(
    "PS.%s asks for one Retry, changing nothing and touching no network, from %s",
    (rowId, _who, facts) => {
      const start = stateOf("chat", rowId);
      const transition = request(rowId, facts as Partial<PendingSendFacts>);
      expect(transition.state).toEqual(start);
      expect(sortedEffects(transition)).toEqual(["request-retry"]);
      expect(outcomeOf(transition)).toBe("applied");
    },
  );

  it.each(LATCHED)(
    "PS.%s refuses the request under another account",
    (rowId) => {
      const start = stateOf("chat", rowId);
      const transition = request(rowId, { accountActive: false, owns: false });
      expect(transition.state).toEqual(start);
      expect(transition.effects).toEqual([]);
      expect(outcomeOf(transition)).toBe("denied-ownership");
    },
  );

  it.each(OTHERS)(
    "PS.%s has no latched failure to retry, so the request does nothing",
    (rowId) => {
      const transition = request(rowId, { owns: false });
      expect(sortedEffects(transition)).not.toContain("request-retry");
      expect(
        transition.effects.filter((effect) =>
          [
            "wake",
            "dispatch",
            "prepare",
            "fetch-model",
            "persist-claim",
          ].includes(effect),
        ),
      ).toEqual([]);
    },
  );

  it("Retry on a latched Not sent with an empty model fetches it when the host is not yet known but client and agent are ready", () => {
    const transition = run(stateOf("chat", "W.notsent"), "retry", {
      ...defaultFacts("W.notsent"),
      host: "unknown",
      clientReady: true,
      agentReady: true,
      frozen: false,
      settingsReady: true,
      stageStatus: "handoff",
      modelReady: false,
      modelUnavailable: true,
    });
    expect(sortedEffects(transition)).toContain("fetch-model");
    expect(
      transition.effects.filter((effect) =>
        ["wake", "dispatch", "prepare", "persist-claim"].includes(effect),
      ),
    ).toEqual([]);
  });
});

describe("guard: a Stop needs a sandbox to stop", () => {
  const WAITING = ROWS.filter((row) => row.phase === "waiting").map(
    (row) => row.id,
  );

  it.each(WAITING)(
    "PS.%s.stop with no sandbox id yet is ignored with no effect, and withdrawal stays allowed",
    (rowId) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, "stop", {
        ...factsFor(rowId, "stop"),
        sandboxKnown: false,
      });
      expect(transition.state).toEqual(start);
      expect(transition.effects).toEqual([]);
      expect(outcomeOf(transition)).toBe("ignored");
      expect(transition.view.canWithdraw).toBe(true);
    },
  );

  it.each(["U", "E"])(
    "PS.%s.stop does not depend on whether a sandbox id is known",
    (rowId) => {
      const known = run(stateOf("chat", rowId), "stop", {
        ...factsFor(rowId, "stop"),
        sandboxKnown: true,
      });
      const unknown = run(stateOf("chat", rowId), "stop", {
        ...factsFor(rowId, "stop"),
        sandboxKnown: false,
      });
      expect(unknown.state).toEqual(known.state);
      expect(sortedEffects(unknown)).toEqual(sortedEffects(known));
      expect(outcomeOf(unknown)).toEqual(outcomeOf(known));
    },
  );

  it.each(WAITING)(
    "PS.%s.cancel with no sandbox id yet still returns the send",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "cancel", {
        ...factsFor(rowId, "cancel"),
        sandboxKnown: false,
      });
      expect(sortedEffects(transition)).toEqual(
        expectedEffects("chat", "ret+remove"),
      );
    },
  );
});

describe("guard: an unknown row never wakes, sends or releases", () => {
  const OBSERVATIONS = [
    "rest",
    "awake",
    "terminal-row",
    "agent-ready",
    "unfrozen",
    "settings-repaired",
    "retry",
    "claim-saved",
    "reload",
    "account-back",
    "storage-changed",
  ] as const;
  const WORLD = ["wake", "dispatch", "end-host", "prepare"];
  const UNKNOWN_CELLS = ROWS.filter((row) => row.id !== "E").flatMap((row) =>
    OBSERVATIONS.map((event) => [row.id, event] as const),
  );
  it.each(UNKNOWN_CELLS)(
    "PS.%s.%s with a loading, stale, failed or foreign list",
    (rowId, event) => {
      const transition = run(stateOf("chat", rowId), event, {
        ...factsFor(rowId, event),
        host: "unknown",
      });
      expect(
        transition.effects.filter((effect) => WORLD.includes(effect)),
      ).toEqual([]);
      expect(transition.state.phase).not.toBe("ended");
    },
  );
});

describe("guard: a missing client alone never releases the claim", () => {
  const CLAIMED = ROWS.filter((row) => CLAIMED_PHASES.has(row.phase)).map(
    (row) => row.id,
  );
  it.each(CLAIMED.filter((id) => id !== "A"))(
    "PS.%s keeps its claim and sends nothing while the host is awake",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "awake", {
        ...factsFor(rowId, "awake"),
        clientReady: false,
      });
      expect(CLAIMED_PHASES.has(transition.state.phase)).toBe(true);
      expect(transition.effects).not.toContain("dispatch");
      expect(transition.effects).not.toContain("end-host");
      expect(transition.effects).not.toContain("remove");
      expect(transition.effects).not.toContain("return-message");
    },
  );

  it.each(CLAIMED.filter((id) => id !== "A"))(
    "PS.%s is still released by an authoritative ended row with no client",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "terminal-row", {
        ...factsFor(rowId, "terminal-row"),
        clientReady: false,
      });
      expect(transition.state.phase).toBe("ended");
      expect(transition.effects).toContain("end-host");
    },
  );
});

describe("guard: handoff needs the captured stage and no pending attach", () => {
  it.each(["handoff", "attach-ok", "attach-unsupported"] as const)(
    "PS.P.%s does nothing once the stage was retargeted",
    (event) => {
      const transition = run(stateOf("fork", "P"), event, {
        ...factsFor("P", event),
        stageCurrent: false,
      });
      expect(transition.effects).toEqual([]);
      expect(transition.state.phase).toBe("staged");
    },
  );

  it("PS.P.handoff waits while an attach is pending, and the picker stays disabled", () => {
    const transition = run(stateOf("fork", "P"), "handoff", {
      ...factsFor("P", "handoff"),
      attachPending: true,
    });
    expect(transition.effects).toEqual([]);
    expect(transition.view.canRetarget).toBe(false);
  });
});

describe("guard: one request at a time against the durable claim", () => {
  it.each(["awake", "retry", "unfrozen", "settings-repaired"] as const)(
    "PS.S.none.%s does not dispatch while a request is in flight",
    (event) => {
      const transition = run(stateOf("chat", "S.none"), event, {
        ...factsFor("S.none", event),
        host: "awake",
        inFlight: true,
      });
      expect(transition.effects).not.toContain("dispatch");
      expect(transition.view.canRetry).toBe(false);
    },
  );

  it("PS.S.none.awake does not dispatch when the claim cannot be read back", () => {
    const transition = run(stateOf("chat", "S.none"), "awake", {
      ...factsFor("S.none", "awake"),
      durableClaim: false,
    });
    expect(transition.effects).not.toContain("dispatch");
  });
});

describe("terminal requests never acquire a claim or an agent", () => {
  const WAITING = ROWS.filter((row) => row.phase === "waiting").map(
    (row) => row.id,
  );
  const FORBIDDEN = [
    "prepare",
    "persist-claim",
    "dispatch",
    "fetch-model",
    "report-provider",
  ];
  it.each(WAITING.flatMap((id) => EVENTS.map((event) => [id, event] as const)))(
    "PS.%s.%s asks the host for no agent, model or claim",
    (rowId, event) => {
      const transition = run(
        stateOf("terminal", rowId),
        event,
        factsFor(rowId, event),
      );
      expect(
        transition.effects.filter((effect) => FORBIDDEN.includes(effect)),
      ).toEqual([]);
    },
  );

  it.each(["cancel", "choose", "return"] as const)(
    "PS.W.host.%s ends a terminal ask with no message to restore",
    (event) => {
      const transition = run(
        stateOf("terminal", "W.host"),
        event,
        factsFor("W.host", event),
      );
      expect(transition.state.phase).toBe("cancelled");
      expect(transition.effects).toEqual(["remove"]);
    },
  );
});

describe("the view follows the state", () => {
  function viewOf(rowId: string, facts: Partial<PendingSendFacts>) {
    // An event that never moves a state, so the view is the given state's.
    return run(stateOf("chat", rowId), "dialog-close", {
      ...defaultFacts(rowId),
      ...facts,
    }).view;
  }

  it.each([
    ["S.credits", "credits"],
    ["Q.credits", "credits"],
    ["S.settings", "settings"],
    ["Q.settings", "settings"],
    ["Q.client", "uncertain"],
    ["Q.none", "uncertain"],
    ["W.model", "model"],
    ["W.provider", "provider"],
    ["W.notsent", "not-sent"],
    ["W.wake", "not-sent"],
    ["D", "delivered"],
    ["R", "hidden"],
    ["C", "hidden"],
  ] as const)("%s shows the %s line", (rowId, line) => {
    expect(viewOf(rowId, {}).line).toBe(line);
  });

  it("hides every line from another account", () => {
    for (const row of ROWS) {
      if (row.phase === "delivered") continue;
      expect(viewOf(row.id, { accountActive: false }).line).toBe("hidden");
    }
  });

  it.each(
    ROWS.filter((row) => CLAIMED_PHASES.has(row.phase)).map((row) => row.id),
  )("%s can never be withdrawn, even by its sole lock holder", (rowId) => {
    expect(viewOf(rowId, { exclusive: true, origin: true }).canWithdraw).toBe(
      false,
    );
  });

  it.each([
    ["Q.none", true],
    ["Q.client", true],
    ["Q.host", true],
    ["S.credits", true],
    ["S.settings", true],
    ["S.wake", true],
    ["S.none", false],
    ["S.host", false],
    ["W.notsent", true],
    ["W.wake", true],
    ["W.host", false],
    ["A", false],
    ["D", false],
  ] as const)("%s offers Retry: %s", (rowId, offered) => {
    expect(viewOf(rowId, {}).canRetry).toBe(offered);
  });

  it.each([
    ["U", true],
    ["W.host", true],
    ["E", true],
    ["S.none", false],
    ["Q.none", false],
    ["A", false],
  ] as const)("%s offers withdrawal: %s", (rowId, offered) => {
    expect(viewOf(rowId, {}).canWithdraw).toBe(offered);
  });

  it("subscribes to models only for a waiting send with a client and no default yet", () => {
    expect(viewOf("W.model", {}).fetchModels).toBe(true);
    expect(viewOf("W.model", { clientReady: false }).fetchModels).toBe(false);
    expect(viewOf("W.host", {}).fetchModels).toBe(false);
    expect(viewOf("S.none", {}).fetchModels).toBe(false);
  });
});

describe("a landing send is handed off unconfirmed", () => {
  it.each(["handoff", "attach-ok", "attach-unsupported"] as const)(
    "PS.P.%s births U when the task is not confirmed, W.host when it is",
    (event) => {
      const landing = run(stateOf("chat", "P"), event, {
        ...factsFor("P", event),
        epicConfirmed: false,
      });
      expect(landing.state).toEqual({
        kind: "chat",
        phase: "unconfirmed",
        blocker: "none",
      });
      expect(landing.effects).toEqual(["handoff"]);
      const inTask = run(stateOf("chat", "P"), event, factsFor("P", event));
      expect(inTask.state).toEqual({
        kind: "chat",
        phase: "waiting",
        blocker: "host",
      });
    },
  );
});

describe("a send whose stage has not reached the handoff", () => {
  const ROWS_WAITING = ["W.host", "W.model", "W.provider", "W.none"];
  const OBSERVED = ["awake", "rest", "agent-ready", "reload"] as const;
  const NEVER = ["prepare", "persist-claim", "dispatch", "fetch-model", "wake"];
  it.each(
    ROWS_WAITING.flatMap((id) =>
      (["staged", "creating"] as const).flatMap((status) =>
        OBSERVED.map((event) => [id, status, event] as const),
      ),
    ),
  )(
    "PS.%s.%s.%s runs the stage and polls, and reaches no host",
    (rowId, status, event) => {
      const transition = run(stateOf("chat", rowId), event, {
        ...factsFor(rowId, event),
        stageStatus: status,
      });
      expect(transition.effects).toContain("run-stage");
      expect(transition.effects).toContain("poll");
      expect(
        transition.effects.filter((effect) => NEVER.includes(effect)),
      ).toEqual([]);
    },
  );
});

describe("a terminal request", () => {
  it.each(["W.host", "W.model", "W.provider", "W.none"])(
    "PS.%s.awake opens the terminal and asks for no agent or model",
    (rowId) => {
      const transition = run(
        stateOf("terminal", rowId),
        "awake",
        factsFor(rowId, "awake"),
      );
      expect(transition.effects).toContain("open-terminal");
      expect(transition.view.fetchModels).toBe(false);
    },
  );

  it.each(["W.host", "W.none"])(
    "PS.%s.terminal-opened delivers the terminal and removes the ask",
    (rowId) => {
      const transition = run(
        stateOf("terminal", rowId),
        "terminal-opened",
        factsFor(rowId, "terminal-opened"),
      );
      expect(transition.state.phase).toBe("delivered");
      expect(transition.effects).toContain("remove");
      expect(transition.effects).not.toContain("return-message");
    },
  );

  it("PS.W.host.terminal-opened is ignored for a chat", () => {
    const transition = run(
      stateOf("chat", "W.host"),
      "terminal-opened",
      factsFor("W.host", "terminal-opened"),
    );
    expect(transition.state.phase).toBe("waiting");
    expect(transition.effects).toEqual([]);
  });
});

describe("guard: commands under the wrong account are denied, not ignored", () => {
  const COMMANDS = ["cancel", "choose", "stop", "return", "retry"] as const;
  const LIVE = ROWS.filter(
    (row) =>
      !["staged", "delivered", "cancelled", "returned"].includes(row.phase),
  ).map((row) => row.id);
  it.each(LIVE.flatMap((id) => COMMANDS.map((event) => [id, event] as const)))(
    "PS.%s.%s is denied-ownership with no effect",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        accountActive: false,
      });
      expect(transition.effects).toEqual([]);
      expect(transition.state).toEqual(start);
      expect(outcomeOf(transition)).toBe("denied-ownership");
    },
  );
});

describe("guard: another account's settlement needs the matching durable claim", () => {
  const SETTLEMENTS = [
    "host-accept",
    "late-accept",
    "known-refusal",
    "transport-fail",
  ] as const;
  const CLAIMED_ROWS = ROWS.filter(
    (row) => row.phase === "sending" || row.phase === "uncertain",
  ).map((row) => row.id);
  it.each(
    CLAIMED_ROWS.flatMap((id) =>
      SETTLEMENTS.map((event) => [id, event] as const),
    ),
  )(
    "PS.%s.%s records nothing once the claim is removed or replaced",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        accountActive: false,
        durableClaim: false,
      });
      expect(transition.effects).toEqual([]);
      expect(transition.state).toEqual(start);
    },
  );
});

describe("an epic that failed to create ends the unconfirmed send directly", () => {
  it("PS.U.epic-create-failed returns the message with no host to end", () => {
    const transition = run(
      stateOf("chat", "U"),
      "epic-create-failed",
      factsFor("U", "epic-create-failed"),
    );
    expect(transition.state.phase).toBe("returned");
    expect(transition.effects).toEqual(["return-message", "remove"]);
  });

  it("PS.U.epic-create-failed is denied without the origin window or a lock", () => {
    const start = stateOf("chat", "U");
    const transition = run(start, "epic-create-failed", {
      ...factsFor("U", "epic-create-failed"),
      origin: false,
      exclusive: false,
    });
    expect(transition.effects).toEqual([]);
    expect(outcomeOf(transition)).toBe("denied-ownership");
  });
});

describe("a wake already in flight", () => {
  it.each(["W.host", "W.model", "W.provider", "W.none", "S.none", "S.host"])(
    "PS.%s.rest polls and does not wake a second time",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "rest", {
        ...factsFor(rowId, "rest"),
        wakeInFlight: true,
      });
      expect(transition.effects).not.toContain("wake");
      expect(transition.effects).toContain("poll");
    },
  );
});

describe("guard: a stale local record whose stored record ended", () => {
  const LIVE = ROWS.filter(
    (row) =>
      !["staged", "delivered", "cancelled", "returned"].includes(row.phase),
  ).map((row) => row.id);
  const EVENTS_SEEN = [
    "awake",
    "rest",
    "reload",
    "storage-changed",
    "retry",
    "cancel",
    "claim-saved",
    "terminal-row",
    "host-accept",
  ] as const;
  it.each(
    LIVE.flatMap((id) => EVENTS_SEEN.map((event) => [id, event] as const)),
  )(
    "PS.%s.%s only rehydrates, with no request, wake, return or removal",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        current: false,
        terminalDisposition: true,
      });
      expect(transition.effects).toEqual(["rehydrate"]);
      expect(transition.state).toEqual(start);
    },
  );

  it.each(LIVE)(
    "PS.%s.account-away does not rehydrate for another account",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "account-away", {
        ...factsFor(rowId, "account-away"),
        current: false,
        terminalDisposition: true,
      });
      expect(transition.effects).toEqual([]);
    },
  );

  it.each(LIVE)(
    "PS.%s.awake does not rehydrate without a stored disposition",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "awake", {
        ...factsFor(rowId, "awake"),
        current: false,
      });
      expect(transition.effects).toEqual([]);
    },
  );
});

describe("guard: a stored Stop outranks the stage, and a stale local record rehydrates it", () => {
  const WAITING = ROWS.filter((row) => row.phase === "waiting").map(
    (row) => row.id,
  );
  const BLOCKERS = [
    "none",
    "host",
    "credits",
    "settings",
    "client",
    "model",
    "provider",
    "not-sent",
    "wake",
  ] as const;
  const EVENTS_SEEN = [
    "awake",
    "rest",
    "reload",
    "storage-changed",
    "retry",
    "cancel",
    "stop",
    "terminal-row",
  ] as const;

  it.each(BLOCKERS)(
    "a record with a stored Stop reads as stopping under the %s stage blocker",
    (blocker) => {
      expect(
        pendingSendState(pendingSend({ stopRequested: true }), blocker).blocker,
      ).toBe("stop");
    },
  );

  it.each(BLOCKERS)(
    "a record without a stored Stop keeps the %s stage blocker",
    (blocker) => {
      expect(
        pendingSendState(pendingSend({ stopRequested: false }), blocker)
          .blocker,
      ).toBe(blocker);
    },
  );

  it.each(
    WAITING.flatMap((id) => EVENTS_SEEN.map((event) => [id, event] as const)),
  )(
    "PS.%s.%s on a stale local record whose stored record holds a Stop only rehydrates",
    (rowId, event) => {
      const start = stateOf("chat", rowId);
      const transition = run(start, event, {
        ...factsFor(rowId, event),
        current: false,
        stopRequested: true,
      });
      expect(transition.effects).toEqual(["rehydrate"]);
      expect(transition.state).toEqual(start);
    },
  );

  it.each(WAITING)(
    "PS.%s.awake does not rehydrate a stale record that holds no Stop",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "awake", {
        ...factsFor(rowId, "awake"),
        current: false,
      });
      expect(transition.effects).toEqual([]);
    },
  );

  it.each(WAITING)(
    "PS.%s.account-away does not rehydrate for another account",
    (rowId) => {
      const transition = run(stateOf("chat", rowId), "account-away", {
        ...factsFor(rowId, "account-away"),
        current: false,
        stopRequested: true,
      });
      expect(transition.effects).toEqual([]);
    },
  );
});

describe("guard: a stage retry runs only where its action is eligible", () => {
  const STAGE_ACTIONS = [
    "retry-stage",
    "retry-creation",
    "keep-waiting",
  ] as const;
  const ELIGIBLE: Readonly<Record<(typeof STAGE_ACTIONS)[number], string[]>> = {
    "retry-stage": ["W.notsent", "W.wake"],
    "retry-creation": ["W.notsent"],
    "keep-waiting": ["W.host", "W.none", "W.notsent", "W.wake"],
  };
  const WAITING = ROWS.filter((row) => row.phase === "waiting").map(
    (row) => row.id,
  );
  const stageRun = (
    rowId: string,
    event: string,
    overlay: Partial<PendingSendFacts>,
  ) =>
    run(stateOf("chat", rowId), event, {
      ...defaultFacts(rowId),
      stageStatus: "creating",
      ...overlay,
    });

  it.each(
    STAGE_ACTIONS.flatMap((action) =>
      ["staged", "creating"].flatMap((stageStatus) =>
        WAITING.map((rowId) => [action, stageStatus, rowId] as const),
      ),
    ),
  )("%s on a %s stage from PS.%s", (action, stageStatus, rowId) => {
    const transition = stageRun(rowId, action, {
      stageStatus: stageStatus as PendingSendFacts["stageStatus"],
    });
    const eligible = ELIGIBLE[action].includes(rowId);
    expect(sortedEffects(transition)).toEqual(
      eligible ? ["poll", "retry", "run-stage"] : [],
    );
    expect(outcomeOf(transition)).toBe(eligible ? "applied" : "ignored");
  });

  it.each(STAGE_ACTIONS)(
    "%s while a wake is in flight polls and starts no second run",
    (action) => {
      const rowId = ELIGIBLE[action][0];
      const transition = stageRun(rowId, action, { wakeInFlight: true });
      expect(sortedEffects(transition)).toEqual(["poll", "retry"]);
    },
  );

  it.each(STAGE_ACTIONS)("%s from a held Stop does nothing", (action) => {
    expect(stageRun("W.stop", action, {}).effects).toEqual([]);
  });

  it.each(STAGE_ACTIONS)(
    "%s refuses an in-flight dispatch and a durable claim",
    (action) => {
      const rowId = ELIGIBLE[action][0];
      expect(stageRun(rowId, action, { inFlight: true }).effects).toEqual([]);
      // A claim the record does not hold is the stale-record guard's to rehydrate.
      expect(stageRun(rowId, action, { durableClaim: true }).effects).toEqual([
        "rehydrate",
      ]);
    },
  );

  it("retry-stage with no stage ignores the request and runs nothing", () => {
    const transition = stageRun("W.wake", "retry-stage", {
      stageStatus: "missing",
    });
    expect(transition.effects).toEqual([]);
    expect(outcomeOf(transition)).toBe("ignored");
  });

  it("retry-stage on a handoff stage uses the readiness plan and never runs a stage", () => {
    const transition = stageRun("W.wake", "retry-stage", {
      stageStatus: "handoff",
    });
    expect(sortedEffects(transition)).toContain("retry");
    expect(sortedEffects(transition)).not.toContain("run-stage");
  });
});

describe("guard: a stage retry request is published only where its action is eligible", () => {
  const CASES = [
    ["send-again", "W.notsent", "handoff", true],
    ["send-again", "W.host", "handoff", false],
    ["retry-stage", "W.wake", "handoff", true],
    ["retry-stage", "W.credits", "handoff", false],
    ["retry-creation", "W.notsent", "creating", true],
    ["retry-creation", "W.wake", "creating", false],
    ["retry-creation", "W.notsent", "handoff", false],
    ["keep-waiting", "W.none", "creating", true],
    ["keep-waiting", "W.host", "staged", true],
    ["keep-waiting", "W.model", "creating", false],
    ["keep-waiting", "W.none", "handoff", false],
  ] as const;

  it.each(CASES)(
    "%s from PS.%s on a %s stage publishes: %s",
    (action, rowId, stageStatus, published) => {
      const transition = run(stateOf("chat", rowId), "request-retry", {
        ...defaultFacts(rowId),
        owns: false,
        exclusive: false,
        origin: false,
        retryAction: action,
        stageStatus,
      });
      expect(sortedEffects(transition)).toEqual(
        published ? ["request-retry"] : [],
      );
    },
  );

  it.each(["retry-stage", "retry-creation", "keep-waiting"] as const)(
    "%s is not published from a held Stop or over a durable claim",
    (action) => {
      const stop = run(stateOf("chat", "W.stop"), "request-retry", {
        ...defaultFacts("W.stop"),
        retryAction: action,
        stageStatus: "creating",
      });
      const claimed = run(stateOf("chat", "W.notsent"), "request-retry", {
        ...defaultFacts("W.notsent"),
        durableClaim: true,
        retryAction: action,
        stageStatus: "creating",
      });
      expect(stop.effects).toEqual([]);
      expect(claimed.effects).toEqual([]);
    },
  );
});

describe("guard: a consumed retry request is always acknowledged and never masks the observation", () => {
  const consume = (rowId: string, overlay: Partial<PendingSendFacts>) =>
    run(stateOf("chat", rowId), "consume-retry", {
      ...defaultFacts(rowId),
      ...overlay,
    });

  it("runs an eligible action and acknowledges it first", () => {
    const transition = consume("W.wake", {
      retryAction: "retry-stage",
      stageStatus: "creating",
    });
    expect(sortedEffects(transition)).toEqual([
      "acknowledge-retry",
      "poll",
      "retry",
      "run-stage",
    ]);
  });

  it("acknowledges a refused action and runs the real observation in the same pass", () => {
    const transition = consume("W.host", {
      retryAction: "retry-creation",
      retryObservation: "terminal-row",
      host: "ended",
    });
    expect(sortedEffects(transition)).toEqual([
      "acknowledge-retry",
      "end-host",
    ]);
    expect(transition.state.phase).toBe("ended");
  });

  it("acknowledges a request over a held Stop and keeps the Stop's progress", () => {
    const transition = consume("W.stop", {
      retryAction: "send-again",
      retryObservation: "observe",
      host: "resting",
    });
    expect(transition.effects).toContain("acknowledge-retry");
    expect(transition.effects).not.toContain("retry");
    expect(transition.effects).toContain("remove");
  });

  it.each(["W.notsent", "W.wake"])(
    "a refused send-again from PS.%s changes no failure and starts no run",
    (rowId) => {
      const transition = consume(rowId, {
        retryAction: "send-again",
        inFlight: true,
      });
      expect(transition.effects).toContain("acknowledge-retry");
      expect(transition.effects).not.toContain("run-stage");
      expect(transition.effects).not.toContain("retry");
    },
  );

  it.each(["A", "D", "C", "R", "E"])(
    "PS.%s is a closed state: a consumed request runs nothing",
    (rowId) => {
      const transition = consume(rowId, {
        retryAction: "retry-stage",
        stageStatus: "creating",
      });
      expect(transition.effects).not.toContain("run-stage");
      expect(transition.effects).not.toContain("retry");
    },
  );

  it("denies a consumed request under another account", () => {
    const transition = consume("W.wake", {
      accountActive: false,
      retryAction: "retry-stage",
      stageStatus: "creating",
    });
    expect(transition.effects).not.toContain("run-stage");
    expect(outcomeOf(transition)).not.toBe("applied");
  });
});

describe("guard: a Retry on a claimed send is published, not executed, by any window", () => {
  const request = (rowId: string, overlay: Partial<PendingSendFacts>) =>
    run(stateOf("chat", rowId), "request-dispatch-retry", {
      ...defaultFacts(rowId),
      ...overlay,
    });
  const PUBLISHES = [
    "Q.none",
    "Q.host",
    "Q.credits",
    "Q.settings",
    "Q.client",
    "Q.wake",
    "S.credits",
    "S.settings",
    "S.wake",
  ];
  const REFUSES = ROWS.map((row) => row.id).filter(
    (id) => !PUBLISHES.includes(id),
  );

  it.each(PUBLISHES)(
    "PS.%s asks its owner for one Retry, from the owner and from a window that does not own it, changing nothing",
    (rowId) => {
      const start = stateOf("chat", rowId);
      for (const facts of [
        { owns: true },
        { owns: false, exclusive: false, origin: false },
      ]) {
        const transition = request(rowId, facts);
        expect(transition.state).toEqual(start);
        expect(sortedEffects(transition)).toEqual(["request-dispatch-retry"]);
        expect(outcomeOf(transition)).toBe("applied");
      }
    },
  );

  it.each(PUBLISHES)(
    "PS.%s refuses the request under another account",
    (rowId) => {
      const transition = request(rowId, { accountActive: false, owns: false });
      expect(transition.effects).toEqual([]);
      expect(outcomeOf(transition)).toBe("denied-ownership");
    },
  );

  it.each(REFUSES)(
    "PS.%s publishes no claimed Retry: it has no live latched claim to replay",
    (rowId) => {
      const transition = request(rowId, { owns: false });
      expect(sortedEffects(transition)).not.toContain("request-dispatch-retry");
    },
  );

  it("does not publish over a record that holds no durable claim", () => {
    expect(request("Q.none", { durableClaim: false }).effects).toEqual([]);
  });
});

describe("guard: only evidence tied to its own request settles a held send", () => {
  const held = { createdAt: 100 };
  const stopped = { createdAt: 100, stopRequested: true, stopRequestedAt: 300 };
  type Request = Parameters<typeof decodePendingSandboxObservation>[0];
  const decode = (
    request: Request,
    observation: PendingSandboxObservation,
    host: "awake" | "resting" | "ended",
  ) => decodePendingSandboxObservation(request, host, observation);
  const decodeAtRest = (
    request: Request,
    observation: PendingSandboxObservation,
  ) => decode(request, observation, "resting");

  it.each([
    ["sent after the mount", 51, "resting"],
    ["sent at the mount", 50, "unknown"],
    ["sent before the mount", 49, "unknown"],
    ["with no send time", null, "unknown"],
  ] as const)("an unheld list read %s", (_label, sentAt, expected) => {
    expect(decodeAtRest(null, { kind: "list", sentAt, mountedAt: 50 })).toBe(
      expected,
    );
  });

  it.each([
    [held, 101, "resting"],
    [held, 100, "unknown"],
    [{ ...held, observationRequestedAt: 200 }, 201, "resting"],
    [{ ...held, observationRequestedAt: 200 }, 200, "unknown"],
    [stopped, 301, "resting"],
    [stopped, 300, "unknown"],
    [{ ...stopped, observationRequestedAt: 400 }, 400, "unknown"],
    [{ ...stopped, observationRequestedAt: 400 }, 401, "resting"],
    // A Stop written before its boundary existed settles on nothing until migrated.
    [{ createdAt: 100, stopRequested: true }, 10_000, "unknown"],
  ] as const)(
    "a held list read of request %j sent at %s settles to %s",
    (request, sentAt, expected) => {
      expect(
        decodeAtRest(request, { kind: "list", sentAt, mountedAt: 0 }),
      ).toBe(expected);
    },
  );

  it("a list read with no send time never settles a held request", () => {
    expect(
      decodeAtRest(held, { kind: "list", sentAt: null, mountedAt: 0 }),
    ).toBe("unknown");
  });

  it.each([
    [stopped, 300, "resting"],
    [stopped, 299, "unknown"],
    [stopped, null, "unknown"],
    [held, 300, "unknown"],
    [null, 300, "unknown"],
  ] as const)(
    "a stop result of request %j captured at %s settles to %s",
    (request, requestedAt, expected) => {
      expect(decodeAtRest(request, { kind: "stop-result", requestedAt })).toBe(
        expected,
      );
    },
  );

  it.each([
    [{ ...held, observationRequestedAt: 200 }, 200, "awake"],
    [{ ...held, observationRequestedAt: 200 }, 199, "unknown"],
    [{ ...held, observationRequestedAt: 200 }, null, "unknown"],
    [held, 200, "unknown"],
    [{ ...stopped, observationRequestedAt: 200 }, 200, "unknown"],
    [null, 200, "unknown"],
  ] as const)(
    "a wake result of request %j captured at %s settles to %s",
    (request, requestedAt, expected) => {
      expect(
        decode(request, { kind: "wake-result", requestedAt }, "awake"),
      ).toBe(expected);
    },
  );

  it.each([
    ["chat-1", "host-1", "awake"],
    ["chat-2", "host-1", "unknown"],
    ["chat-1", "host-2", "unknown"],
  ] as const)(
    "a dispatch result for %s on %s settles to %s",
    (chatId, hostId, expected) => {
      const request = {
        ...held,
        dispatch: { input: { chatId: "chat-1", hostId: "host-1" } },
      };
      expect(
        decode(request, { kind: "dispatch-result", chatId, hostId }, "awake"),
      ).toBe(expected);
      expect(
        decode(held, { kind: "dispatch-result", chatId, hostId }, "awake"),
      ).toBe("unknown");
    },
  );

  it("a legacy claimed record without an observation boundary settles on no list read until its owner migrates it", () => {
    const claimed = {
      ...held,
      dispatch: { input: { chatId: "chat-1", hostId: "host-1" } },
    };
    expect(
      decodeAtRest(claimed, { kind: "list", sentAt: 10_000, mountedAt: 0 }),
    ).toBe("unknown");
    expect(
      decodeAtRest(
        { ...claimed, observationRequestedAt: 200 },
        { kind: "list", sentAt: 201, mountedAt: 0 },
      ),
    ).toBe("resting");
  });

  it("a dispatch result matches the accepted receipt's identity as well as the saved input", () => {
    const accepted = {
      ...held,
      delivery: { chatId: "chat-1", hostId: "host-1" },
    };
    expect(
      decode(
        accepted,
        { kind: "dispatch-result", chatId: "chat-1", hostId: "host-1" },
        "awake",
      ),
    ).toBe("awake");
    expect(
      decode(
        accepted,
        { kind: "dispatch-result", chatId: "chat-2", hostId: "host-1" },
        "awake",
      ),
    ).toBe("unknown");
  });

  it.each([
    [held, "resting", "resting"],
    [held, "awake", "unknown"],
    [held, "ended", "unknown"],
    [stopped, "resting", "unknown"],
    [null, "resting", "unknown"],
  ] as const)(
    "an intent against request %j on a %s host settles to %s",
    (request, host, expected) => {
      expect(decode(request, { kind: "intent" }, host)).toBe(expected);
    },
  );

  it("no observation settles anything", () => {
    expect(decodeAtRest(held, { kind: "none" })).toBe("unknown");
    expect(decodeAtRest(null, { kind: "none" })).toBe("unknown");
  });
});
