/**
 * Lockstep between the host's canonical V8 flags and the copy of them the
 * desktop bakes into its bundled LaunchAgent plist.
 *
 * `inject-host-launch-agent.cjs` is a CommonJS prepack script in a package that
 * does not depend on this one, so it cannot import {@link HOST_V8_FLAGS} and
 * necessarily HARDCODES the value. Duplication that nothing checks is how the
 * two stop agreeing: the 16 -> 64 raise had to find this second copy by
 * grepping, and the next change to the cap has no reason to look.
 *
 * ## What drift actually costs, stated honestly
 *
 * Less than the uninstaller lockstep beside this one, and the difference is
 * worth writing down so nobody reads this test as load-bearing for the host's
 * heap. The plist launches `traycer host start`, and the supervisor spawns the
 * host through `withHostNodeOptions`, which STRIPS the inherited
 * `--max-semi-space-size` and re-appends the canonical one. So a stale plist
 * mis-sizes the supervisor's own young generation and nothing else; the host
 * gets the right cap either way. That strip is deliberate and is what carries
 * the raise to machines nobody reinstalls.
 *
 * It is still worth pinning. A plist that disagrees with the source of truth is
 * what an operator sees in `launchctl print`, and a value that looks
 * authoritative while being ignored is a worse thing to debug than one that is
 * merely wrong. And the reasoning for the number - the allocation bursts it has
 * to sit above, and the kill criterion that reverts it - lives in one place; a
 * second copy drifting away from that comment is how the number becomes folklore.
 *
 * This test lives in the CLI package rather than the desktop one because this
 * package owns the source of truth, and it reads the desktop's file by path (no
 * import) so it asserts against the REAL committed script rather than a copy of
 * its contents. Editing either side alone reddens it.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_V8_FLAGS } from "../../host-node-options";

const DESKTOP_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "desktop",
);

const INJECT_SCRIPT_PATH = join(
  DESKTOP_ROOT,
  "scripts",
  "prepack",
  "inject-host-launch-agent.cjs",
);

function readInjectScript(): string {
  return readFileSync(INJECT_SCRIPT_PATH, "utf8");
}

/**
 * The plist's `NODE_OPTIONS` value, read out of the script's own declaration.
 *
 * Throws rather than returning null on a miss, because every caller here would
 * otherwise assert against `undefined` and report "expected undefined to be
 * --max-semi-space-size=64" - which reads as a drifted VALUE when the actual
 * failure is a renamed or restructured constant, and sends the reader to the
 * wrong file.
 */
function declaredHostNodeOptions(source: string): string {
  const declaration = /^const HOST_NODE_OPTIONS = "([^"]*)";$/m.exec(source);
  if (declaration === null) {
    throw new Error(
      `inject-host-launch-agent.cjs no longer declares HOST_NODE_OPTIONS as a ` +
        `double-quoted string literal on one line. It is the desktop's copy of ` +
        `HOST_V8_FLAGS; if it moved or was renamed, update this lockstep to ` +
        `follow it rather than deleting the check.`,
    );
  }
  return declaration[1];
}

describe("desktop LaunchAgent NODE_OPTIONS / HOST_V8_FLAGS lockstep", () => {
  it("bakes exactly the canonical V8 flags into the bundled plist", () => {
    expect(declaredHostNodeOptions(readInjectScript())).toBe(HOST_V8_FLAGS);
  });

  it("actually writes that constant into the plist, rather than a second literal", () => {
    // The constant agreeing is not enough on its own: a plist that interpolated
    // its own inline string would pass the row above while shipping something
    // else entirely. Asserting the interpolation is the same move the
    // uninstaller lockstep makes by resolving the macro through the field
    // electron-builder really reads.
    const source = readInjectScript();

    expect(source).toContain(
      "<string>${escapeXml(HOST_NODE_OPTIONS)}</string>",
    );
    expect(source.match(/--max-semi-space-size/g)).toHaveLength(1);
  });

  it("keeps the cap in the creation-time form Node accepts in NODE_OPTIONS", () => {
    // `--max-semi-space-size` must reach V8 at process creation - a runtime
    // `v8.setFlagsFromString` does not cap `new_space` - and NODE_OPTIONS
    // rejects the whole string on a malformed token, which stops the agent
    // starting at all. So the shape is pinned, not just the number.
    expect(declaredHostNodeOptions(readInjectScript())).toMatch(
      /^--max-semi-space-size=\d+$/,
    );
  });
});
