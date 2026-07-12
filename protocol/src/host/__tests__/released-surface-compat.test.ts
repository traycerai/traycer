import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

/**
 * Released method-name guard for the unary `/rpc` handshake.
 *
 * The per-method handshake (`compatibility-checker`) is fail-closed on the
 * METHOD-NAME SET: a method name present on only one peer is a fatal
 * `Incompatible methods` error that makes EVERY RPC fail against a peer on the
 * other version. That is exactly how `1.0.1-rc.1` broke against the shipped
 * `host-v1.0.0` - `worktree.readScriptsAtRef` was added as a NEW method name.
 *
 * So the method-name set is frozen to the last release a peer in the field may
 * still be running (`__fixtures__/released-method-names.ts`, a snapshot of
 * `host-v1.0.0`; regenerate with
 * `protocol/scripts/snapshot-released-method-names.ts`). A new capability must
 * ride a new `{ major, minor }` of an EXISTING method, never a new method name.
 *
 * ROLE: this test is a FAST LOCAL TRIPWIRE only. The authoritative gate is the
 * `protocol-compat` CI workflow, which dumps every released baseline's surface
 * from its immutable git tag (`protocol/scripts/compat/`) - a baseline no PR
 * can edit. Editing the fixture here does NOT change what CI verifies (that
 * edit-the-fixture path is exactly how `terminal.defaultCwd` shipped
 * handshake-incompatible in #227), and the fixture file itself is tripwired:
 * changing it requires the `protocol-compat-override` label.
 *
 * Scope: this guards only the handshake-fatal class (name-set mismatch). It does
 * NOT freeze per-method schemas - the CI gate covers those (same-version
 * wire-schema rules with reviewed exceptions in `compat-exceptions.json`).
 *
 * When this fails, fold the capability into an existing method and version it
 * (see `worktree.listByWorkspacePaths@1.1` / `worktree.listBindingsForEpic@1.1`).
 */
describe("released method-name set (host-v1.0.0) is frozen", () => {
  it("advertises every baselined method name in the fatal floor channel", () => {
    // Post-#272 the registry may grow ADDITIVE optional methods beyond the
    // floor; those ride the optional manifest channel and are not
    // handshake-fatal. The frozen floor itself must remain fully present.
    const current = new Set(Object.keys(hostRpcRegistry));
    const missing = [...releasedMethodNames].filter(
      (name) => !current.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("requires every non-floor method to declare a degrade story", () => {
    const floor = new Set<string>(releasedMethodNames);
    const optionalWithoutDegrade = Object.entries(hostRpcRegistry)
      .filter(([name]) => !floor.has(name))
      .filter(([, entry]) => !("degrade" in entry))
      .map(([name]) => name);
    expect(optionalWithoutDegrade).toEqual([]);
  });
});
