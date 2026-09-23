import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { releasedStreamMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-stream-method-names";

/**
 * Registration invariants for the `agentIdentity.*` family.
 *
 * `released-surface-compat` already proves the general rule - every non-floor
 * method states a degrade - by sweeping the whole registry. This file pins the
 * FAMILY: that its member list is exactly what the contract says it is, that
 * every member opens at 1.0 with no bridges, and that not one of the fifteen
 * names leaked into a released baseline.
 *
 * The last point is the one a sweep cannot make. A name added to
 * `released-method-names.ts` would make the general guard pass and the handshake
 * fail against every shipped peer, which is precisely the `terminal.defaultCwd`
 * incident the fixture's own header records. Naming the family here means that
 * edit fails a test that says why.
 */

// `import.hermes.*` (T12) has schemas but is not registered until its host
// resolvers land - the host's resolver-coverage gate fails an advertised
// method with no resolver. T12 adds its names here when it registers them.
const EXPECTED_UNARY_METHODS = [
  "agentIdentity.create",
  "agentIdentity.delete",
  "agentIdentity.files.add",
  "agentIdentity.files.delete",
  "agentIdentity.files.readBlob",
  "agentIdentity.files.rename",
  "agentIdentity.files.uploadBlob",
  "agentIdentity.history.list",
  "agentIdentity.history.restore",
  "agentIdentity.list",
  "agentIdentity.skills.import",
  "agentIdentity.skills.inspect",
  "agentIdentity.update",
] as const;

const EXPECTED_STREAM_METHODS = [
  "agentIdentity.file.subscribe",
  "agentIdentity.state.subscribe",
] as const;

function agentIdentityNames(names: readonly string[]): readonly string[] {
  return names.filter((name) => name.startsWith("agentIdentity.")).sort();
}

describe("agentIdentity.* registration", () => {
  it("registers exactly the unary methods the family declares", () => {
    expect(agentIdentityNames(Object.keys(hostRpcRegistry))).toEqual([
      ...EXPECTED_UNARY_METHODS,
    ]);
  });

  it("registers exactly the two stream methods, which are one capability", () => {
    expect(agentIdentityNames(Object.keys(hostStreamRpcRegistry))).toEqual([
      ...EXPECTED_STREAM_METHODS,
    ]);
  });

  it("opens every unary at 1.0 with no bridges and an explicit degrade", () => {
    for (const method of EXPECTED_UNARY_METHODS) {
      const entry = hostRpcRegistry[method];
      // A brand-new name has no released baseline, so there is nothing to
      // upgrade FROM and no older major to downgrade TO. Anything here would be
      // machinery bridging a line no peer has ever spoken.
      expect(Object.keys(entry).filter((key) => /^\d+$/.test(key))).toEqual([
        "1",
      ]);
      expect(entry[1].latestMinor).toBe(0);
      expect(Object.keys(entry[1].versions)).toEqual(["0"]);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
      // Required of every non-floor method, and load-bearing here: it is what a
      // client reads to hide the Identities section against an older host.
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].versions[0].contract.method).toBe(method);
      expect(entry[1].versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
    }
  });

  it("opens both streams at 1.0 with a single installed minor", () => {
    for (const method of EXPECTED_STREAM_METHODS) {
      const entry = hostStreamRpcRegistry[method];
      expect(Object.keys(entry)).toEqual(["1"]);
      expect(entry[1].latestMinor).toBe(0);
      expect(Object.keys(entry[1].versions)).toEqual(["0"]);
      expect(entry[1].versions[0].contract.method).toBe(method);
    }
  });

  it("keeps every name out of the released floor and both released fixtures", () => {
    // Three separate lists, and all three matter. A name in the floor export or
    // the unary fixture is handshake-fatal against a shipped peer, because the
    // unary `/rpc` handshake is fail-closed on the method-NAME union. The stream
    // fixture is a subset guard rather than an equality one, so a name added
    // there would not fail its own test - only this one.
    expect(agentIdentityNames(RELEASED_FLOOR_METHOD_NAMES)).toEqual([]);
    expect(agentIdentityNames(releasedMethodNames)).toEqual([]);
    expect(agentIdentityNames(releasedStreamMethodNames)).toEqual([]);
  });
});
