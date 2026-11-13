import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHostMentionEntries } from "@/hooks/composer/use-host-mention-entries";
import type { MentionFlowStep } from "@/lib/composer/mentions";

const hosts = [
  { hostId: "offline-42", label: "Studio Laptop" },
  { hostId: "other-1", label: "Office" },
];
const empty = { entries: [], matchedCount: 0, candidates: [] };
const root: MentionFlowStep = { kind: "root" };
const submenu: MentionFlowStep = {
  kind: "provider",
  providerId: "hosts",
  stepId: "root",
  workspacePath: null,
};
afterEach(cleanup);

describe("host mention entries", () => {
  it("offers one category at root and finds it by host name or id", () => {
    const { result, rerender } = renderHook(
      ({ query }) =>
        useHostMentionEntries(root, query, empty, { hosts, answered: true }),
      { initialProps: { query: "" } },
    );
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "provider:hosts",
    ]);
    expect(result.current.entries[0]?.action).toMatchObject({
      kind: "navigate",
      step: submenu,
    });
    rerender({ query: "studio" });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "provider:hosts",
    ]);
    rerender({ query: "OFFLINE-42" });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "provider:hosts",
    ]);
    rerender({ query: "unrelated" });
    expect(result.current.entries).toEqual([]);
  });

  it("filters hosts in the submenu and retains the canonical id", () => {
    const { result, rerender } = renderHook(
      ({ query }) =>
        useHostMentionEntries(submenu, query, empty, { hosts, answered: true }),
      { initialProps: { query: "" } },
    );
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "mention-back",
      "host:offline-42",
      "host:other-1",
    ]);
    rerender({ query: "OFFLINE-42" });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "mention-back",
      "host:offline-42",
    ]);
    expect(result.current.entries[1]?.action).toMatchObject({
      kind: "complete",
      mention: { contextType: "host", hostId: "offline-42" },
    });
  });
  it("ranks submenu matches by host name and durable id", () => {
    const rankedHosts = [
      { hostId: "machine-long-42", label: "Development Laptop" },
      { hostId: "machine-42", label: "Laptop" },
    ];
    const { result, rerender } = renderHook(
      ({ query }) =>
        useHostMentionEntries(submenu, query, empty, {
          hosts: rankedHosts,
          answered: true,
        }),
      { initialProps: { query: "Laptop" } },
    );
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "mention-back",
      "host:machine-42",
      "host:machine-long-42",
    ]);
    rerender({ query: "machine-42" });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "mention-back",
      "host:machine-42",
      "host:machine-long-42",
    ]);
  });
});
