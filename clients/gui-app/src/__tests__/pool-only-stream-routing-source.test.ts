import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_STREAM_RPC_ROUTES } from "@traycer-clients/shared/host-client/host-rpc-routing";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const APP_FILES = globSync(["**/*.ts", "**/*.tsx"], {
  cwd: SRC,
  exclude: ["**/node_modules", "**/__tests__"],
}).map((file) => join(SRC, file));
const ROUTED_STREAM_PROVIDERS = new Map([
  ["chat.serving.subscribe", "providers/chat-serving-witness-provider.tsx"],
  ["environment.chats.subscribe", "providers/environment-arm-scope-mount.tsx"],
  [
    "environment.plainTerminals.subscribe",
    "providers/environment-arm-scope-mount.tsx",
  ],
  [
    "environment.communicationGraph.subscribe",
    "providers/environment-arm-scope-mount.tsx",
  ],
]);

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    "\n".repeat((block.match(/\n/g) ?? []).length),
  );
  return withoutBlocks.replace(/\/\/[^\n]*/g, "");
}

describe("pool-only stream subscriptions use the routed client", () => {
  const poolOnlyMethods = Object.entries(HOST_STREAM_RPC_ROUTES)
    .filter(([, route]) => route === "pool-only")
    .map(([method]) => method)
    .sort();

  it("derives all four pool-only streams from the route table", () => {
    expect(poolOnlyMethods).toEqual([
      "chat.serving.subscribe",
      "environment.chats.subscribe",
      "environment.communicationGraph.subscribe",
      "environment.plainTerminals.subscribe",
    ]);
  });

  it("keeps the removed pool-tier hook out of app source and routes each stream at its provider", () => {
    expect(APP_FILES.length).toBeGreaterThan(100);
    const violations: string[] = [];
    for (const file of APP_FILES) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (/\busePoolTierStreamClient\b/.test(source)) {
        violations.push(`${relative(SRC, file)} uses usePoolTierStreamClient`);
      }
    }

    const routedProviders = new Map<string, string>();
    for (const [method, path] of ROUTED_STREAM_PROVIDERS) {
      const file = join(SRC, path);
      const source = stripComments(readFileSync(file, "utf8"));
      if (
        source.includes("useRoutedStreamClient") &&
        source.includes(`"${method}"`)
      ) {
        routedProviders.set(method, path);
      }
    }
    expect([...routedProviders.keys()].sort()).toEqual(poolOnlyMethods);
    expect(violations).toEqual([]);

    const chatProvider = stripComments(
      readFileSync(
        join(SRC, "providers/chat-serving-witness-provider.tsx"),
        "utf8",
      ),
    );
    const environmentProvider = stripComments(
      readFileSync(
        join(SRC, "providers/environment-arm-scope-mount.tsx"),
        "utf8",
      ),
    );
    const environmentWorkers = stripComments(
      readFileSync(
        join(SRC, "hooks/environment/use-environment-arms.ts"),
        "utf8",
      ),
    );
    expect(chatProvider).toContain("witness.setStreamClient(poolStreamClient)");
    expect(environmentProvider).toContain("publishEnvironmentArmScope(scope)");
    expect(environmentProvider).toContain("client,");
    expect(environmentWorkers).toContain("useEnvironmentArmScope(");
  });

  it("confines direct subscriptions to workers fed by those routed providers", () => {
    const allowedSubscribers = new Map([
      [
        "lib/chats/pool-chat-serving-witness.ts",
        new Set(["chat.serving.subscribe"]),
      ],
      [
        "hooks/environment/use-environment-arms.ts",
        new Set([
          "environment.chats.subscribe",
          "environment.communicationGraph.subscribe",
          "environment.plainTerminals.subscribe",
        ]),
      ],
    ]);
    const subscriberMethods = new Map<string, Set<string>>();
    const methodsPattern = poolOnlyMethods.join("|");
    const subscribeCall = new RegExp(
      String.raw`\.(?:subscribe|subscribeWithParamsProvider)\s*\(\s*"(${methodsPattern})"`,
      "g",
    );
    for (const file of APP_FILES) {
      const source = stripComments(readFileSync(file, "utf8"));
      const path = relative(SRC, file);
      for (const match of source.matchAll(subscribeCall)) {
        const methods = subscriberMethods.get(path) ?? new Set<string>();
        methods.add(match[1]);
        subscriberMethods.set(path, methods);
      }
    }

    expect(
      [...subscriberMethods.entries()]
        .map(([path, methods]) => [path, [...methods].sort()] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual(
      [...allowedSubscribers.entries()]
        .map(([path, methods]) => [path, [...methods].sort()] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  });
});
