import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PersonalPageContext,
  usePersonalHostName,
} from "@/components/settings/personal/personal-page-context";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";

function nameOnPageWith(hostName: string): string | null {
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <PersonalPageContext.Provider
      value={{
        section: "secrets",
        pick: { kind: "personal" },
        state: { kind: "ready", status: environmentStatusFixture({}) },
        line: null,
        hostName,
        localOverrides: [],
        hostId: null,
        client: null,
        notices: [],
        review: [],
      }}
    >
      {props.children}
    </PersonalPageContext.Provider>
  );
  return renderHook(() => usePersonalHostName(), { wrapper }).result.current;
}

describe("usePersonalHostName", () => {
  it("answers the page's host name", () => {
    expect(nameOnPageWith("dev-box")).toBe("dev-box");
  });

  it("answers null for a page that carries an empty name, so a caller names the host itself", () => {
    expect(nameOnPageWith("")).toBeNull();
  });

  it("answers null outside a Personal page", () => {
    expect(renderHook(() => usePersonalHostName()).result.current).toBeNull();
  });
});
