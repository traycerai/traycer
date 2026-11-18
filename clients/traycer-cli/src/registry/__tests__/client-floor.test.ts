import { describe, expect, it } from "vitest";

import { LOCAL_CLI_VERSION } from "../../cli-version";
import {
  evaluateHostClientFloor,
  hostClientFloorRefusalMessage,
  isHostClientFloorRefusal,
} from "../client-floor";

describe("evaluateHostClientFloor", () => {
  it("passes a version that declares no floor", () => {
    expect(
      evaluateHostClientFloor({
        cliVersion: "1.0.0",
        requiredCliVersion: null,
      }),
    ).toEqual({ kind: "unfloored" });
  });

  it("refuses a CLI below the declared floor", () => {
    const verdict = evaluateHostClientFloor({
      cliVersion: "1.1.8",
      requiredCliVersion: "1.2.0",
    });
    expect(verdict).toEqual({
      kind: "below-floor",
      requiredCliVersion: "1.2.0",
      cliVersion: "1.1.8",
    });
    expect(isHostClientFloorRefusal(verdict)).toBe(true);
  });

  it("admits a CLI at the floor and above it", () => {
    expect(
      evaluateHostClientFloor({
        cliVersion: "1.2.0",
        requiredCliVersion: "1.2.0",
      }).kind,
    ).toBe("satisfied");
    expect(
      evaluateHostClientFloor({
        cliVersion: "2.0.0",
        requiredCliVersion: "1.2.0",
      }).kind,
    ).toBe("satisfied");
  });

  // Full SemVer precedence, not a numeric-triplet compare: a release candidate
  // is BELOW its own GA, and shipping the floor at the GA must not admit the
  // RC that predates the change the floor exists for.
  it("ranks a release candidate below its own GA", () => {
    expect(
      evaluateHostClientFloor({
        cliVersion: "1.2.0-rc.1",
        requiredCliVersion: "1.2.0",
      }).kind,
    ).toBe("below-floor");
  });

  // The exemption is BY NAME. A local build reports `0.0.0-local`, which is
  // genuinely below every floor - blocking it would leave a dev machine unable
  // to install a floored host at all. Named rather than range-checked so the
  // exemption cannot widen to a real released version that happens to sort
  // low.
  it("waives the floor for an unreleased build, and only for that exact version", () => {
    expect(
      evaluateHostClientFloor({
        cliVersion: LOCAL_CLI_VERSION,
        requiredCliVersion: "9.9.9",
      }).kind,
    ).toBe("unreleased-cli");
    expect(
      evaluateHostClientFloor({
        cliVersion: "0.0.0",
        requiredCliVersion: "9.9.9",
      }).kind,
    ).toBe("below-floor");
    expect(
      evaluateHostClientFloor({
        cliVersion: "0.0.0-localish",
        requiredCliVersion: "9.9.9",
      }).kind,
    ).toBe("below-floor");
  });

  // Fail CLOSED. Degrading a malformed floor to "no floor" would make one
  // publisher typo the way to disable the floor fleet-wide, silently, which is
  // the failure mode the whole item exists to remove.
  it("refuses a floor it cannot compare against instead of ignoring it", () => {
    const verdict = evaluateHostClientFloor({
      cliVersion: "9.9.9",
      requiredCliVersion: "v1.2.0",
    });
    expect(verdict.kind).toBe("floor-unreadable");
    expect(isHostClientFloorRefusal(verdict)).toBe(true);
  });

  it("refuses a CLI whose own version does not parse", () => {
    expect(
      evaluateHostClientFloor({
        cliVersion: "local-build-1234",
        requiredCliVersion: "1.2.0",
      }).kind,
    ).toBe("below-floor");
  });
});

describe("hostClientFloorRefusalMessage", () => {
  // The remedy is to update the CLI, not to pick another host. A message that
  // said "choose a different version" would send the user to exactly the
  // workaround that reinstates the problem.
  it("names both versions and points at the CLI", () => {
    const message = hostClientFloorRefusalMessage(
      {
        kind: "below-floor",
        requiredCliVersion: "1.2.0",
        cliVersion: "1.1.8",
      },
      "1.9.0",
    );
    expect(message).toContain("1.2.0");
    expect(message).toContain("1.1.8");
    expect(message).toContain("1.9.0");
    expect(message).toMatch(/update traycer/iu);
  });

  it("quotes an unreadable floor so whitespace is visible", () => {
    expect(
      hostClientFloorRefusalMessage(
        { kind: "floor-unreadable", requiredCliVersion: "1.2.0 " },
        "1.9.0",
      ),
    ).toContain('"1.2.0 "');
  });
});
