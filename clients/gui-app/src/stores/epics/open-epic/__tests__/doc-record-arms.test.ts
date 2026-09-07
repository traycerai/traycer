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
 * `recordNegotiatedHostMethods` is the legacy name-only path and deliberately clears versions, so
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
    // The class a single condition would have got wrong.
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
    // `< 1.1` is the test, not `=== 1.1`: a `@1.2` host serves the remainder too, and a
    // version-equality check would silently restore the doc arm on every host that moves past this
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
    // `recordNegotiatedHostMethods` carries no versions and clears any it had, so the registry answers
    // `null` for the minor.
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
    // The registry is overwritten by the next handshake, so an unknown resolves rather than latching -
    // which is what stops a `false` verdict outliving the host that gave it.
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
