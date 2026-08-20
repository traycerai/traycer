import { describe, expect, it } from "vitest";
import { isSelfNamingCliInvocation } from "../cli-invocation-shape";

// `isSelfNamingCliInvocation` recognizes the pre-fix packaged fallback's
// broken vector - `<SEA> traycer host start`, `<SEA> /usr/local/bin/traycer
// host start`, `<SEA> ./traycer host start` - so callers that would
// otherwise preserve an existing registration verbatim can re-resolve
// instead. See the doc comment on the function under test for the full
// rationale; these cases pin the shape it must (and must not) recognize.
describe("isSelfNamingCliInvocation", () => {
  it("is true for a bare command-name leading arg matching the command's basename", () => {
    expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["traycer"],
      }),
    ).toBe(true);
  });

  it("is true when the leading arg IS the command's own absolute path", () => {
    expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["/usr/local/bin/traycer"],
      }),
    ).toBe(true);
  });

  it("is true for a relative './traycer' leading arg naming the same command", () => {
    expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["./traycer"],
      }),
    ).toBe(true);
  });

  it("is false for an empty args list", () => {
    expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: [],
      }),
    ).toBe(false);
  });

  it("is false for a legitimate interpreter registration naming a different entry file", () => {
    expect(
      isSelfNamingCliInvocation({
        command: "/usr/bin/node",
        args: ["/repo/dist/index.js"],
      }),
    ).toBe(false);
  });

  it("is false when there are two or more leading args, even if the first would self-name alone", () => {
    expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["traycer", "start"],
      }),
    ).toBe(false);
  });
});
