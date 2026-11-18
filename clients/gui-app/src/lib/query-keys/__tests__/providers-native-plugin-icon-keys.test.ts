import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  providersNativeQueryKeys,
  type NativeListScopeParams,
} from "@/lib/query-keys/providers-native-query-keys";

// Annotated, not inferred: a bare object literal widens `providerId` and
// `scope` to `string` and stops matching the builders' parameter type.
const SCOPE: NativeListScopeParams = {
  providerId: "codex",
  scope: "global",
  workspaceRoot: null,
};

function iconKey(args: {
  readonly hostId: string | null;
  readonly pluginId: string;
  readonly theme: "light" | "dark";
  readonly version: string | null;
}): QueryKey {
  return providersNativeQueryKeys.pluginIcon(args.hostId, {
    ...SCOPE,
    pluginId: args.pluginId,
    theme: args.theme,
    version: args.version,
  });
}

/**
 * `isPluginIconKey` is what a plugin mutation invalidates through. It exists
 * because `version` is NULLABLE: a versioned plugin retires its own cache entry
 * by changing the key, but one that reports no version keeps the identical key
 * across a remove-then-add, and with `staleTime: Infinity` and polling off that
 * entry would serve the previous install's artwork for the rest of the session.
 */
describe("providersNativeQueryKeys.isPluginIconKey", () => {
  it("matches every icon on its host - any plugin, theme, or version", () => {
    for (const key of [
      iconKey({
        hostId: "h1",
        pluginId: "pdf@m",
        theme: "light",
        version: null,
      }),
      iconKey({
        hostId: "h1",
        pluginId: "pdf@m",
        theme: "dark",
        version: null,
      }),
      iconKey({
        hostId: "h1",
        pluginId: "git@m",
        theme: "light",
        version: "2",
      }),
    ]) {
      expect(providersNativeQueryKeys.isPluginIconKey("h1", key)).toBe(true);
    }
  });

  it("does not match another host's icons", () => {
    // A plugin mutation is host-scoped; invalidating across hosts would refetch
    // megabytes of artwork nobody asked about.
    const other = iconKey({
      hostId: "h2",
      pluginId: "pdf@m",
      theme: "light",
      version: null,
    });
    expect(providersNativeQueryKeys.isPluginIconKey("h1", other)).toBe(false);
  });

  it("does not match the sibling native lists on the same host", () => {
    // These share the host prefix AND the `providers`/`native` segments, so a
    // looser prefix test would sweep them in - and the plugins list is written
    // directly by the mutation, so invalidating it would undo that write with
    // a refetch.
    expect(
      providersNativeQueryKeys.isPluginIconKey(
        "h1",
        providersNativeQueryKeys.pluginsList("h1", SCOPE),
      ),
    ).toBe(false);
    expect(
      providersNativeQueryKeys.isPluginIconKey(
        "h1",
        providersNativeQueryKeys.skillsList("h1", SCOPE),
      ),
    ).toBe(false);
  });

  it("does not match a key shorter than the host scope", () => {
    expect(providersNativeQueryKeys.isPluginIconKey("h1", ["providers"])).toBe(
      false,
    );
  });
});
