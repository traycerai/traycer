import { describe, expect, it, vi } from "vitest";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import {
  unavailableHostOption,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import {
  ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE,
  buildFixedHostWorkspaceControlsScope,
  hostPickerOptionsForScope,
  type HostWorkspaceControlsHostScope,
} from "../host-workspace-controls-scope";

/**
 * "Continue on a <team> host" narrows the host picker to that team's hosts. The
 * selected host is listed whatever the narrowing says, so the picker never
 * hides its own value.
 */

const H1 = unavailableHostOption("h1", "Host one");
const H2 = unavailableHostOption("h2", "Host two");
const H3 = unavailableHostOption("h3", "Host three");
const HOSTS: readonly HostScopeOption[] = [H1, H2, H3];

function selectedScope(
  hostId: string,
  onlyHostIds: ReadonlySet<string> | null,
): HostWorkspaceControlsHostScope {
  return {
    kind: "selected",
    hostId,
    hostClient: null,
    onSelect: vi.fn(),
    refusalByHostId: NO_HOST_OPTION_REFUSALS,
    unselectableExceptHostId: null,
    onlyHostIds,
  };
}

function listedIds(options: readonly HostScopeOption[]): readonly string[] {
  return options.map((option) => option.hostId);
}

describe("hostPickerOptionsForScope", () => {
  it("lists only the hosts in a selected scope's onlyHostIds", () => {
    const scope = selectedScope("h1", new Set(["h1", "h2"]));

    const options = hostPickerOptionsForScope(scope, H1, H1, HOSTS);

    expect(listedIds(options)).toEqual(["h1", "h2"]);
  });

  it("keeps the selected host listed when it is outside the set", () => {
    const scope = selectedScope("h3", new Set(["h1", "h2"]));

    const options = hostPickerOptionsForScope(scope, H3, H3, HOSTS);

    expect(new Set(listedIds(options))).toEqual(new Set(["h1", "h2", "h3"]));
    expect(listedIds(options)).toHaveLength(3);
  });

  it("keeps a selected host the lists do not carry, and still narrows the rest", () => {
    const stranger = unavailableHostOption("h9", "Host nine");
    const scope = selectedScope("h9", new Set(["h1", "h2"]));

    const options = hostPickerOptionsForScope(scope, stranger, null, HOSTS);

    expect(new Set(listedIds(options))).toEqual(new Set(["h9", "h1", "h2"]));
    expect(listedIds(options)).toHaveLength(3);
  });

  it("lists every host when onlyHostIds is null", () => {
    const scope = selectedScope("h1", null);

    const options = hostPickerOptionsForScope(scope, H1, H1, HOSTS);

    expect(listedIds(options)).toEqual(["h1", "h2", "h3"]);
  });

  it("lists every host for the app-wide active scope", () => {
    const options = hostPickerOptionsForScope(
      ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE,
      H1,
      H1,
      HOSTS,
    );

    expect(listedIds(options)).toEqual(["h1", "h2", "h3"]);
  });

  it("lists only the one host of a fixed scope", () => {
    const scope = buildFixedHostWorkspaceControlsScope({
      hostId: "h2",
      hostClient: null,
    });

    const options = hostPickerOptionsForScope(scope, H2, H2, HOSTS);

    expect(listedIds(options)).toEqual(["h2"]);
  });

  it("lists nothing for a fixed scope with no selected host", () => {
    const scope = buildFixedHostWorkspaceControlsScope({
      hostId: "h2",
      hostClient: null,
    });

    expect(hostPickerOptionsForScope(scope, null, null, HOSTS)).toEqual([]);
  });
});
