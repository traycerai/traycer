import type { HostListItem } from "@traycer/protocol/host/host-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationDetailsRecord } from "@/components/settings/panels/host-settings-installation-details";
import {
  deriveAboutThisHost,
  deriveInstallationDetails,
  deriveInstallRecordRows,
  type HostOverviewAboutSource,
  type InstallationDetailRow,
  type InstallationDetailsSource,
} from "@/components/settings/panels/host-overview-installation-model";

const NOW_MS = Date.parse("2026-09-24T12:00:00Z");
const LONG_HOST_ID = "8f14e45fceea167a5a36dedd4bea2543c9a2";

afterEach(() => {
  vi.useRealTimers();
});

function item(
  lastSeenAt: string | null,
  overrides: Partial<HostListItem>,
): HostListItem {
  return {
    hostId: "host-a",
    displayName: null,
    platform: "linux-x64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-03-03T12:00:00Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt,
    },
    updatePolicy: "manual",
    ...overrides,
  };
}

function about(
  lastSeenAt: string | null,
  overrides: Partial<HostListItem>,
): HostOverviewAboutSource {
  return { item: item(lastSeenAt, overrides), nowMs: NOW_MS };
}

function withAppVersion(
  lastSeenAt: string | null,
  appVersion: string | null,
): HostOverviewAboutSource {
  return about(lastSeenAt, {
    status: { ...item(lastSeenAt, {}).status, appVersion, lastSeenAt },
  });
}

function installRecord(): InstallationDetailsRecord {
  return {
    version: "1.5.0",
    runtimeVersion: "1.5.0",
    installedAt: "2026-08-10T00:00:00Z",
    source: { kind: "registry", value: "1.5.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    signatureKeyId: "key-1",
    platform: "darwin",
    arch: "arm64",
  };
}

function detail(
  rows: readonly InstallationDetailRow[],
  testId: string,
): InstallationDetailRow {
  const found = rows.find((candidate) => candidate.testId === testId);
  expect(found).toBeDefined();
  if (found === undefined) {
    throw new Error(`missing installation detail ${testId}`);
  }
  return found;
}

function absent(rows: readonly InstallationDetailRow[], testId: string): void {
  expect(rows.some((candidate) => candidate.testId === testId)).toBe(false);
}

function details(
  source: InstallationDetailsSource,
): readonly InstallationDetailRow[] {
  return deriveInstallationDetails(source);
}

describe("deriveAboutThisHost", () => {
  it("uses the Settings date for when the host was added to the account", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const view = deriveAboutThisHost({
      item: item(null, {
        createdAt: new Date(2026, 9, 24, 8, 35).toISOString(),
      }),
      nowMs: Date.now(),
    });

    expect(view.addedToAccount).toBe("24 Oct");
  });

  it("collapses a host that never checked in to one line", () => {
    const view = deriveAboutThisHost(about(null, {}));
    expect(view.unseenLine).toBe("Not seen since it was added");
  });

  it("shows an unparsable createdAt as it came", () => {
    const view = deriveAboutThisHost(
      about(null, { createdAt: "yesterday-ish" }),
    );
    expect(view.addedToAccount).toBe("yesterday-ish");
    expect(view.unseenLine).toBe("Not seen since it was added");
  });
});

describe("deriveInstallationDetails", () => {
  it("shows one build version line when the running version and the registry version agree", () => {
    const live = details({
      about: about("2026-09-24T09:00:00Z", {}),
      live: true,
      runningVersion: "1.5.0",
      record: installRecord(),
    });
    expect(detail(live, "settings-host-install-version").value).toBe(
      "v1.5.0 · from this host now",
    );
    absent(live, "host-overview-about-version");

    const offline = details({
      about: about("2026-09-24T09:00:00Z", {}),
      live: false,
      runningVersion: "1.5.0",
      record: null,
    });
    expect(detail(offline, "settings-host-install-version").value).toBe(
      "v1.5.0 · last account report, 3h ago",
    );
    absent(offline, "host-overview-about-version");
  });

  it("shows the running version and the registry version when their displays differ", () => {
    const live = details({
      about: withAppVersion("2026-09-24T09:00:00Z", "1.4.2"),
      live: true,
      runningVersion: "1.6.0",
      record: installRecord(),
    });
    expect(detail(live, "settings-host-install-version")).toMatchObject({
      label: "Build version",
      value: "v1.6.0 · from this host now",
    });
    expect(detail(live, "host-overview-about-version")).toMatchObject({
      label: "Last reported version",
      value: "v1.4.2 · last account report, 3h ago",
    });

    const offline = details({
      about: withAppVersion("2026-09-24T09:00:00Z", "1.4.2"),
      live: false,
      runningVersion: "1.6.0",
      record: null,
    });
    expect(detail(offline, "settings-host-install-version").value).toBe(
      "v1.6.0",
    );
    expect(detail(offline, "host-overview-about-version").value).toBe(
      "v1.4.2 · last account report, 3h ago",
    );
  });

  it("says the account received no version when the registry version is missing", () => {
    for (const appVersion of [null, ""]) {
      const rows = details({
        about: withAppVersion("2026-09-24T09:00:00Z", appVersion),
        live: true,
        runningVersion: "1.5.0",
        record: null,
      });
      expect(detail(rows, "host-overview-about-version").value).toBe(
        "No version received by the account",
      );
    }
  });

  it("words a live install record as from this host now, including architecture", () => {
    const rows = details({
      about: about("2026-09-24T09:00:00Z", {}),
      live: true,
      runningVersion: "1.5.0",
      record: { ...installRecord(), platform: "linux", arch: "x64" },
    });
    expect(detail(rows, "host-overview-about-platform").value).toBe(
      "Linux · from this host now",
    );
    expect(detail(rows, "host-overview-about-architecture").value).toBe(
      "x64 · from this host now",
    );
  });

  it("words the account triple, including architecture, when the record is not live", () => {
    const rows = details({
      about: about("2026-09-24T09:00:00Z", { platform: "darwin-arm64" }),
      live: false,
      runningVersion: "1.5.0",
      record: null,
    });
    expect(detail(rows, "host-overview-about-platform").value).toBe(
      "macOS · last account report, 3h ago",
    );
    expect(detail(rows, "host-overview-about-architecture").value).toBe(
      "arm64 · last account report, 3h ago",
    );
  });

  it("drops the elapsed words when the account stamp is missing or unparsable", () => {
    const unseen = details({
      about: about(null, { platform: "win32-x64" }),
      live: false,
      runningVersion: "1.5.0",
      record: null,
    });
    expect(detail(unseen, "host-overview-about-platform").value).toBe(
      "Windows · last account report",
    );
    expect(detail(unseen, "host-overview-about-architecture").value).toBe(
      "x64 · last account report",
    );

    const unparsable = details({
      about: about("not-a-date", { platform: "linux-x64" }),
      live: false,
      runningVersion: "1.5.0",
      record: null,
    });
    expect(detail(unparsable, "host-overview-about-platform").value).toBe(
      "Linux · last account report",
    );
  });

  it("omits platform and architecture when neither source knows them", () => {
    const rows = details({
      about: about(null, { platform: null }),
      live: false,
      runningVersion: null,
      record: null,
    });
    absent(rows, "host-overview-about-platform");
    absent(rows, "host-overview-about-architecture");
    absent(rows, "settings-host-install-version");
  });

  it("falls back to the live install record when there is no running version", () => {
    const semver = details({
      about: about("2026-09-24T09:00:00Z", {}),
      live: true,
      runningVersion: null,
      record: {
        ...installRecord(),
        version: "local-runtime-stamp",
        runtimeVersion: "1.5.0",
      },
    });
    expect(detail(semver, "settings-host-install-version").value).toBe(
      "v1.5.0 · from this host now",
    );
    absent(semver, "host-overview-about-version");

    const sentinel = details({
      about: about("2026-09-24T09:00:00Z", {}),
      live: true,
      runningVersion: null,
      record: {
        ...installRecord(),
        version: "bridge-9.9.9",
        runtimeVersion: null,
      },
    });
    expect(detail(sentinel, "settings-host-install-version").value).toBe(
      "vbridge-9.9.9 · from this host now",
    );
    expect(detail(sentinel, "host-overview-about-version").value).toBe(
      "v1.5.0 · last account report, 3h ago",
    );
  });

  it("abbreviates the host id inside Details and keeps the full id on the copy button", () => {
    const rows = details({
      about: about("2026-09-24T09:00:00Z", { hostId: LONG_HOST_ID }),
      live: true,
      runningVersion: "1.5.0",
      record: null,
    });
    expect(detail(rows, "host-overview-about-host-id")).toMatchObject({
      label: "Host ID",
      value: "8f14e45f…c9a2",
      copy: { value: LONG_HOST_ID, label: "Copy host ID" },
    });
  });

  it("omits the host id and the registry row when the account has no record", () => {
    const rows = details({
      about: null,
      live: true,
      runningVersion: "1.5.0",
      record: installRecord(),
    });
    absent(rows, "host-overview-about-host-id");
    absent(rows, "host-overview-about-version");
    expect(detail(rows, "settings-host-install-version").value).toBe(
      "v1.5.0 · from this host now",
    );
  });
});

describe("deriveInstallRecordRows", () => {
  it("shows the install id as Build when it is not the running version", () => {
    const rows = deriveInstallRecordRows(
      { ...installRecord(), version: "bridge-9.9.9", runtimeVersion: null },
      "1.1.11",
    );
    expect(detail(rows, "settings-host-install-build").value).toBe(
      "bridge-9.9.9",
    );
    absent(rows, "settings-host-install-version");
    absent(rows, "host-overview-about-platform");
    expect(detail(rows, "settings-host-install-source").value).toBe(
      "Registry · 1.5.0",
    );
  });

  it("omits Build when the install id is already the running version", () => {
    const rows = deriveInstallRecordRows(installRecord(), "1.5.0");
    absent(rows, "settings-host-install-build");
    expect(detail(rows, "settings-host-install-source").value).toContain(
      "Registry",
    );
  });

  it("keeps a digest of 16 characters whole and shortens a longer one to head 8 and tail 4, with the full digest on the copy button", () => {
    const whole = deriveInstallRecordRows(
      { ...installRecord(), archiveSha256: "a".repeat(16) },
      "1.5.0",
    );
    expect(detail(whole, "settings-host-install-sha256")).toMatchObject({
      value: "a".repeat(16),
      copy: { value: "a".repeat(16), label: "Copy SHA-256" },
    });

    const shortened = deriveInstallRecordRows(
      { ...installRecord(), archiveSha256: "0123456789abcdefg" },
      "1.5.0",
    );
    expect(detail(shortened, "settings-host-install-sha256")).toMatchObject({
      value: "01234567…defg",
      copy: { value: "0123456789abcdefg", label: "Copy SHA-256" },
    });
  });

  it("omits the SHA-256 row when the record has no digest", () => {
    absent(
      deriveInstallRecordRows(
        { ...installRecord(), archiveSha256: "" },
        "1.5.0",
      ),
      "settings-host-install-sha256",
    );
    absent(
      deriveInstallRecordRows(
        { ...installRecord(), archiveSha256: null },
        "1.5.0",
      ),
      "settings-host-install-sha256",
    );
  });

  it("uses Settings dates for installation and verification", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const rows = deriveInstallRecordRows(
      {
        ...installRecord(),
        installedAt: new Date(2025, 9, 25, 8, 35).toISOString(),
        signatureVerifiedAt: new Date(2026, 9, 25, 8, 35).toISOString(),
      },
      "1.5.0",
    );
    expect(detail(rows, "settings-host-install-installed").value).toBe(
      "25 Oct 2025",
    );
    expect(detail(rows, "settings-host-verification").value).toBe(
      "Verified 08:35",
    );
  });

  it("reads 'Unsigned local build' as a warning for the CLI's unsigned sentinel key, never Verified", () => {
    // An unsigned local-file install stamps `signatureVerifiedAt` with the
    // install time anyway, so the key id is what says no signature was checked.
    const rows = deriveInstallRecordRows(
      {
        ...installRecord(),
        signatureKeyId: "local-file:unsigned",
        signatureVerifiedAt: "2026-08-01T00:00:00Z",
      },
      "1.5.0",
    );
    const verification = detail(rows, "settings-host-verification");
    expect(verification.value).toBe("Unsigned local build");
    expect(verification.tone).toBe("warning");
  });

  it("reads 'Verified <date>' as success when a real key verified the archive", () => {
    const rows = deriveInstallRecordRows(
      {
        ...installRecord(),
        signatureKeyId: "key-1",
        signatureVerifiedAt: "2026-08-01T00:00:00Z",
      },
      "1.5.0",
    );
    const verification = detail(rows, "settings-host-verification");
    expect(verification.value).toMatch(/^Verified /);
    expect(verification.tone).toBe("success");
  });

  it("reads 'Unverified' as a warning when nothing verified it and the key is not the unsigned sentinel", () => {
    const rows = deriveInstallRecordRows(
      {
        ...installRecord(),
        signatureKeyId: "key-1",
        signatureVerifiedAt: null,
      },
      "1.5.0",
    );
    const verification = detail(rows, "settings-host-verification");
    expect(verification.value).toBe("Unverified");
    expect(verification.tone).toBe("warning");
  });
});
