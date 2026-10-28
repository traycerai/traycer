/**
 * The build without environments (`unreleased-features.ts`): the sidebar
 * mounts this instead of the Environment dropdown, and every page the
 * dropdown would govern reads the picked host as its Local row.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostPickAsLocalRow } from "@/components/settings/environment/host-pick-as-local-row";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import {
  useEnvironmentPick,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

afterEach(() => {
  cleanup();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

function Pick(): string {
  return JSON.stringify(useEnvironmentPick());
}

describe("<HostPickAsLocalRow />", () => {
  it("makes the picked host the window's pick, as its Local row", () => {
    const scope = hostScopeFixture({
      host: hostScopeOptionFixture({ hostId: "laptop", name: "Laptop" }),
    });
    const { container } = render(
      <>
        <HostPickAsLocalRow scope={scope} />
        <Pick />
      </>,
    );
    expect(JSON.parse(container.textContent)).toEqual({
      kind: "local",
      hostId: "laptop",
      hostName: "Laptop",
    });
  });

  it("follows the Host picker to another host", () => {
    const first = hostScopeFixture({
      host: hostScopeOptionFixture({ hostId: "laptop", name: "Laptop" }),
    });
    const second = hostScopeFixture({
      host: hostScopeOptionFixture({ hostId: "desk", name: "Desk" }),
    });
    const { container, rerender } = render(
      <>
        <HostPickAsLocalRow scope={first} />
        <Pick />
      </>,
    );
    rerender(
      <>
        <HostPickAsLocalRow scope={second} />
        <Pick />
      </>,
    );
    expect(JSON.parse(container.textContent)).toEqual({
      kind: "local",
      hostId: "desk",
      hostName: "Desk",
    });
  });

  it("names no host while the window has none", () => {
    const { container } = render(
      <>
        <HostPickAsLocalRow scope={hostScopeFixture({ host: null })} />
        <Pick />
      </>,
    );
    expect(JSON.parse(container.textContent)).toEqual(PERSONAL_PICK);
  });
});
