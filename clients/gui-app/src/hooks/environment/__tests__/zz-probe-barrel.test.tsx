// Local check only: a test that mocks @/lib/host with importOriginal reads
// the environment cloud through the mocked binding.
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const probeCloud = {
  authnBaseUrl: "https://authn.test/",
  bearer: { getBearerToken: () => "probe-token" },
  transport: async () => ({ status: 200, text: "{}" }),
  onOriginSignIn: () => true,
};

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => ({ auth: { environmentCloud: () => probeCloud } }),
  };
});

import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";

describe("PROBE barrel", () => {
  it("PROBE barrel: useEnvironmentCloud sees the mocked binding", () => {
    const { result } = renderHook(() => useEnvironmentCloud());
    expect(result.current?.()).toBe(probeCloud);
  });
});
