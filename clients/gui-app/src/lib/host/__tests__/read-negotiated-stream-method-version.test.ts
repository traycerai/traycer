import { afterEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedStreamMethodVersions,
  resetNegotiatedStreamVersions,
} from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";
import { readNegotiatedStreamMethodVersion } from "../read-negotiated-stream-method-version";

describe("readNegotiatedStreamMethodVersion", () => {
  afterEach(() => {
    resetNegotiatedStreamVersions();
  });

  it("returns null when the host has no recorded stream handshake", () => {
    expect(
      readNegotiatedStreamMethodVersion("host-1", "chat.subscribe"),
    ).toBeNull();
  });

  it("returns the recorded version for a method the host can bridge", () => {
    recordNegotiatedStreamMethodVersions(
      "host-1",
      new Map([["chat.subscribe", { major: 1, minor: 11 }]]),
    );

    expect(
      readNegotiatedStreamMethodVersion("host-1", "chat.subscribe"),
    ).toEqual({ major: 1, minor: 11 });
  });

  it("returns null for a method the host's map does not name, even after another method was recorded", () => {
    recordNegotiatedStreamMethodVersions(
      "host-1",
      new Map([["chat.subscribe", { major: 1, minor: 11 }]]),
    );

    expect(
      readNegotiatedStreamMethodVersion("host-1", "drafts.subscribe"),
    ).toBeNull();
  });

  it("is scoped per host id", () => {
    recordNegotiatedStreamMethodVersions(
      "host-1",
      new Map([["chat.subscribe", { major: 1, minor: 11 }]]),
    );

    expect(
      readNegotiatedStreamMethodVersion("host-2", "chat.subscribe"),
    ).toBeNull();
  });
});
