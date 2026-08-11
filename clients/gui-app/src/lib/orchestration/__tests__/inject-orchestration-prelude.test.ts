import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import type { OrchestrationBinding } from "@/stores/orchestration/orchestration-binding-store";
import {
  maybeInjectOrchestrationPreludeAtCreate,
  type OrchestrationInjectionFailure,
} from "../inject-orchestration-prelude";

const DOC: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "hello" }] },
  ],
};

const ENABLED: OrchestrationBinding = {
  enabled: true,
  orchestrationName: "dev-team",
  roleId: "orchestrator",
  modelGroup: null,
};

function makeCli(
  impl: ITraycerCli["orchestrationPrelude"],
): ITraycerCli {
  return { orchestrationPrelude: impl } as ITraycerCli;
}

describe("maybeInjectOrchestrationPreludeAtCreate", () => {
  it("cli-unavailable invokes onFailure once", async () => {
    const onFailure = vi.fn<(r: OrchestrationInjectionFailure) => void>();
    const result = await maybeInjectOrchestrationPreludeAtCreate(
      DOC,
      null,
      ENABLED,
      onFailure,
    );
    expect(result).toBe(DOC);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      kind: "cli-unavailable",
      orchestrationName: "dev-team",
      roleId: "orchestrator",
    });
  });

  it("empty-prelude invokes onFailure once", async () => {
    const onFailure = vi.fn<(r: OrchestrationInjectionFailure) => void>();
    const cli = makeCli(async () => null);
    const result = await maybeInjectOrchestrationPreludeAtCreate(
      DOC,
      cli,
      ENABLED,
      onFailure,
    );
    expect(result).toBe(DOC);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "empty-prelude" }),
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("prelude-error invokes onFailure once", async () => {
    const onFailure = vi.fn<(r: OrchestrationInjectionFailure) => void>();
    const cli = makeCli(async () => {
      throw new Error("boom");
    });
    const result = await maybeInjectOrchestrationPreludeAtCreate(
      DOC,
      cli,
      ENABLED,
      onFailure,
    );
    expect(result).toBe(DOC);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "prelude-error" }),
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("success path does not invoke onFailure", async () => {
    const onFailure = vi.fn<(r: OrchestrationInjectionFailure) => void>();
    const cli = makeCli(async () => ({
      text: "<!-- traycer-orchestration-prelude -->\nx\n<!-- /traycer-orchestration-prelude -->",
      orchestration: "dev-team",
      roleId: "orchestrator",
      roleLabel: "Orchestrator",
      modelGroup: "default",
      tier: "default",
    }));
    const result = await maybeInjectOrchestrationPreludeAtCreate(
      DOC,
      cli,
      ENABLED,
      onFailure,
    );
    expect(result).not.toBe(DOC);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("disabled binding does not invoke onFailure", async () => {
    const onFailure = vi.fn<(r: OrchestrationInjectionFailure) => void>();
    const result = await maybeInjectOrchestrationPreludeAtCreate(
      DOC,
      null,
      { ...ENABLED, enabled: false },
      onFailure,
    );
    expect(result).toBe(DOC);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("incomplete binding does not invoke onFailure", async () => {
    const onFailure = vi.fn<(r: OrchestrationInjectionFailure) => void>();
    const result = await maybeInjectOrchestrationPreludeAtCreate(
      DOC,
      null,
      { ...ENABLED, orchestrationName: "" },
      onFailure,
    );
    expect(result).toBe(DOC);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
