import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import { ViewReplicaStore } from "@traycer-clients/shared/view-replica/store";
import { ViewReplicaLifecycleMount } from "@/providers/view-replica-lifecycle-mount";
import { useAuthStore } from "@/stores/auth/auth-store";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import {
  historyReplicaAddress,
  historyReplicaService,
} from "@/lib/view-replica/history-replica";
import {
  VIEW_REPLICA_DB_NAME,
  viewReplicaStore,
} from "@/lib/view-replica/view-replica-store";
import {
  HOST,
  OTHER_ACCOUNT,
  TEAM,
  ACCOUNT,
  historyPage,
  taskIds,
  taskLight,
} from "@/lib/view-replica/__tests__/replica-fixtures";

const TEAMS = [{ teamId: TEAM, slug: "team-slug", avatarUrl: null }];

function cachedIds(accountId: string): readonly string[] | null {
  const address = historyReplicaAddress(accountId, HOST, LIST_CLOUD_TASKS_REQUEST);
  if (address === null) throw new Error("Expected a History address");
  const hit = viewReplicaStore.read(historyReplicaService, address);
  return hit === null ? null : taskIds(hit.page);
}

/** A previous session's replica for `accountId`: on disk, not in memory. */
async function seedPreviousSession(accountId: string): Promise<void> {
  const previous = new ViewReplicaStore(
    createIndexedDbViewReplicaBackend(
      () => globalThis.indexedDB,
      VIEW_REPLICA_DB_NAME,
    ),
  );
  await previous.warm(accountId);
  const address = historyReplicaAddress(accountId, HOST, LIST_CLOUD_TASKS_REQUEST);
  if (address === null) throw new Error("Expected a History address");
  const page: ListTasksResponse = historyPage([
    taskLight("mine", null),
    taskLight("teams", TEAM),
  ]);
  previous.write(historyReplicaService, address, page, {
    observedAt: 100,
    sourceGeneration: null,
  });
  await previous.drain();
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
    shareableTeams: TEAMS,
    cloudVerdictLoss: "unreachable",
  });
}

async function mountSignedIn(userId: string): Promise<void> {
  await seedPreviousSession(userId);
  signIn(userId);
  render(<ViewReplicaLifecycleMount />);
  await waitFor(() => expect(viewReplicaStore.isWarm(userId)).toBe(true));
}

describe("ViewReplicaLifecycleMount", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(async () => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    await viewReplicaStore.evict({ kind: "identity-retired" });
  });

  it("warms the signed-in account's cached pages", async () => {
    await mountSignedIn(ACCOUNT);

    expect(cachedIds(ACCOUNT)).toEqual(["mine", "teams"]);
  });

  it("wipes the replica when the person signs out", async () => {
    await mountSignedIn(ACCOUNT);

    act(() => {
      useAuthStore.getState().setSignedOut();
    });

    await waitFor(() => expect(cachedIds(ACCOUNT)).toBeNull());
    expect(viewReplicaStore.isWarm(ACCOUNT)).toBe(false);
  });

  it("wipes every cached page when another account takes the session, and warms the new account from an empty replica", async () => {
    await mountSignedIn(ACCOUNT);

    act(() => {
      signIn(OTHER_ACCOUNT);
    });

    await waitFor(() => expect(viewReplicaStore.isWarm(OTHER_ACCOUNT)).toBe(true));
    expect(cachedIds(ACCOUNT)).toBeNull();
    expect(cachedIds(OTHER_ACCOUNT)).toBeNull();
  });

  it("withdraws a removed team's rows while the same person stays signed in", async () => {
    await mountSignedIn(ACCOUNT);

    act(() => {
      useAuthStore.setState({ shareableTeams: [] });
    });

    await waitFor(() => expect(cachedIds(ACCOUNT)).toEqual(["mine"]));
  });

  it("does not read an empty team list as a removal when no verdict is held", async () => {
    await mountSignedIn(ACCOUNT);

    act(() => {
      useAuthStore.setState({ status: "unverified", shareableTeams: [] });
    });

    expect(cachedIds(ACCOUNT)).toEqual(["mine", "teams"]);
  });
});
