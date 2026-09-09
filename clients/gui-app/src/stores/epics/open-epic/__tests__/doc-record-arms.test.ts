/**
 * The three host classes the released floor makes reachable, and what the doc
 * arm does on each.
 *
 * This is the verification the cutover's flip actually needs.
 * `GUI_PROJECTS_EPIC_DOC_REPLICA` is now `false`, and the reason that is safe is
 * NOT that the doc arm was deleted - it is that the arm survives exactly where
 * the record plane cannot cover the rows, decided per population from what the
 * host negotiated.
 *
 * `epic.listChatRecords` and `epic.listTuiAgents` are both permanently OFF
 * `RELEASED_FLOOR_METHOD_NAMES` (adding a name to that list is handshake-fatal
 * against every released peer, so it cannot grow), which is what makes a host
 * that answers `E_HOST_UNSUPPORTED` to both a supported host rather than a
 * hypothetical one. On such a host the doc is the ONLY place its chats and
 * terminal agents exist, and deleting the arm would render the epic empty -
 * not degraded, empty.
 *
 * The two planes do not share a condition, and a single test over one of them
 * would have missed it:
 *
 *  - **Chats** are complete on any host that answers the method at all, at any
 *    minor, because `EpicChatRegistry.hydrate()` runs
 *    `hydrateLegacyDocSecondary` unconditionally before any resolver executes.
 *  - **Terminal agents** are complete only at `@1.1`. There is no shim on that
 *    plane, and at `@1.0` the host deliberately WITHHOLDS doc-only entries
 *    because its contract says the caller still unions its own doc projection.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { readEpicDocRecordArms } from "@/stores/epics/open-epic/doc-record-arms";

const HOST = "host-1";

beforeEach(() => {
  resetNegotiatedManifests();
});

afterEach(() => {
  resetNegotiatedManifests();
});

/**
 * Record a manifest carrying VERSIONS, which is what a real `openAck` does -
 * `recordNegotiatedHostMethods` is the legacy name-only path and deliberately
 * clears versions, so a test that used it could never reach the `@1.1` arm.
 */
function negotiate(entries: Readonly<Record<string, [number, number]>>): void {
  recordNegotiatedHostManifest(
    HOST,
    Object.fromEntries(
      Object.entries(entries).map(([method, [major, minor]]) => [
        method,
        { major, minor },
      ]),
    ),
  );
}

describe("class 1: a released-floor host, answering neither list method", () => {
  it("keeps the doc arm on for BOTH populations", () => {
    // Nothing recorded at all. Its chats and terminal agents exist only in the
    // doc, so switching the arm off here empties the epic.
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: true,
      tuiAgents: true,
    });
  });

  it("keeps it on for a host that negotiated OTHER methods but not these", () => {
    // The stronger version: a handshake completed, and it did not include
    // either list method. Absence here is an answer, not silence.
    negotiate({ "epic.subscribe": [1, 3], "epic.renameChat": [1, 0] });
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: true,
      tuiAgents: true,
    });
  });
});

describe("class 2: listChatRecords present, listTuiAgents only at @1.0", () => {
  it("switches the CHAT arm off and leaves the TERMINAL arm on", () => {
    // The class a single condition would have got wrong. Chats are covered by
    // the registry's unconditional hydration shim at any minor; terminal agents
    // are not covered at all until `@1.1` serves the remainder.
    negotiate({
      "epic.listChatRecords": [1, 0],
      "epic.listTuiAgents": [1, 0],
    });
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: false,
      tuiAgents: true,
    });
  });

  it("covers chats at @1.1 on that plane too - presence is the condition", () => {
    negotiate({
      "epic.listChatRecords": [1, 1],
      "epic.listTuiAgents": [1, 0],
    });
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: false,
      tuiAgents: true,
    });
  });
});

describe("class 3: both planes at @1.1", () => {
  it("switches BOTH arms off - the post-cutover normal", () => {
    negotiate({
      "epic.listChatRecords": [1, 1],
      "epic.listTuiAgents": [1, 1],
    });
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: false,
      tuiAgents: false,
    });
  });

  it("and a later minor keeps them off", () => {
    // `< 1.1` is the test, not `=== 1.1`: a `@1.2` host serves the remainder
    // too, and a version-equality check would silently restore the doc arm on
    // every host that moves past this minor.
    negotiate({
      "epic.listChatRecords": [1, 4],
      "epic.listTuiAgents": [1, 2],
    });
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: false,
      tuiAgents: false,
    });
  });
});

describe("fail-closed means the DOC stays on", () => {
  it("answers doc-for-both for a session with no host bound yet", () => {
    expect(readEpicDocRecordArms(null)).toEqual({
      chats: true,
      tuiAgents: true,
    });
  });

  it("answers doc-for-both for a host whose handshake has not completed", () => {
    negotiate({ "epic.listChatRecords": [1, 1] });
    // A DIFFERENT host, with nothing recorded.
    expect(readEpicDocRecordArms("some-other-host")).toEqual({
      chats: true,
      tuiAgents: true,
    });
  });

  it("keeps the TERMINAL arm on when only a name-only recording exists", () => {
    // `recordNegotiatedHostMethods` carries no versions and clears any it had,
    // so the registry answers `null` for the minor. That is one of three cases
    // it cannot distinguish - absent, not yet handshaked, name-only - and all
    // three mean "we cannot prove `@1.1`", which is the arm-ON answer. The chat
    // arm still switches off, because presence alone is its condition.
    recordNegotiatedHostMethods(HOST, [
      "epic.listChatRecords",
      "epic.listTuiAgents",
    ]);
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: false,
      tuiAgents: true,
    });
  });

  it("is self-correcting: a host upgraded in place moves the arms", () => {
    // The registry is overwritten by the next handshake, so an unknown resolves
    // rather than latching - which is what stops a `false` verdict outliving
    // the host that gave it.
    negotiate({ "epic.listTuiAgents": [1, 0] });
    expect(readEpicDocRecordArms(HOST).tuiAgents).toBe(true);
    negotiate({
      "epic.listChatRecords": [1, 1],
      "epic.listTuiAgents": [1, 1],
    });
    expect(readEpicDocRecordArms(HOST)).toEqual({
      chats: false,
      tuiAgents: false,
    });
  });
});
