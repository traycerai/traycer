import { describe, expect, it } from "vitest";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "./__fixtures__/released-method-names";

describe("released floor production module", () => {
  it("matches the guarded released method-name fixture element-for-element", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toEqual(releasedMethodNames);
  });
});
