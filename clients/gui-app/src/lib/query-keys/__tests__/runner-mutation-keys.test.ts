import { describe, expect, it } from "vitest";
import {
  runnerQueryKeys,
  supportBridgeQueryScopeId,
} from "@/lib/query-keys/runner-mutation-keys";

describe("support bridge query scopes", () => {
  it("keeps one serializable scope per bridge instance", () => {
    const first = { getSnapshot: () => Promise.resolve("first") };
    const second = { getSnapshot: () => Promise.resolve("second") };

    const firstScope = supportBridgeQueryScopeId(first);
    const repeatedFirstScope = supportBridgeQueryScopeId(first);
    const secondScope = supportBridgeQueryScopeId(second);

    expect(firstScope).toBe(repeatedFirstScope);
    expect(secondScope).not.toBe(firstScope);
    expect(
      JSON.stringify(runnerQueryKeys.supportSnapshot(firstScope)),
    ).not.toBe(JSON.stringify(runnerQueryKeys.supportSnapshot(secondScope)));
  });
});
