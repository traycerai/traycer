import {
  desktopReleaseTag,
  isRecord,
  projectDesktopRelease,
  type DesktopReleaseAsset,
  type DesktopReleaseCandidate,
  type DesktopReleaseOrigin,
  type DesktopVersionAssets,
} from "./desktop-release-feed";

import { config } from "../../config";

function desktopCdnBase(): string {
  return config.environment === "staging"
    ? "https://releases.dev.traycer.ai/desktop/"
    : "https://releases.traycer.ai/desktop/";
}

export interface DesktopReleaseIndex {
  readonly stableHead: string | null;
  readonly versions: readonly DesktopReleaseCandidate[];
}

export function desktopReleaseOrigins(
  owner: string,
  repo: string,
  release: DesktopReleaseCandidate,
  versions: readonly DesktopVersionAssets[] | null,
  githubFirst: boolean,
): readonly DesktopReleaseOrigin[] {
  const cdn: DesktopReleaseOrigin = {
    url: `${desktopCdnBase()}${encodeURIComponent(release.version)}/`,
    blockMapAssets: versions ?? [],
  };
  const github: DesktopReleaseOrigin = {
    url: `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release.tag)}/`,
    blockMapAssets: null,
    assets: githubFirst ? release.assets : undefined,
  };
  return githubFirst ? [github, cdn] : [cdn, github];
}

export async function fetchDesktopReleaseIndex(
  channel: "stable" | "rc" | "staging",
  owner: string,
  repo: string,
  signal: AbortSignal | undefined,
): Promise<DesktopReleaseIndex> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`${desktopCdnBase()}${channel}/index.json`, {
    headers: { accept: "application/json" },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Desktop release index failed with HTTP ${response.status}`,
    );
  }
  if (response.body === null)
    throw new Error("Desktop release index has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new Error("Desktop release index exceeds its size limit");
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(raw);
  return parseDesktopReleaseIndex(value, channel, owner, repo);
}

function parseDesktopReleaseIndex(
  value: unknown,
  channel: "stable" | "rc" | "staging",
  owner: string,
  repo: string,
): DesktopReleaseIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.channel !== channel ||
    !isTimestamp(value.generatedAt) ||
    (channel === "staging"
      ? value.stableHead !== null
      : typeof value.stableHead !== "string") ||
    !Array.isArray(value.versions) ||
    value.versions.length > (channel === "staging" ? 20 : 21)
  ) {
    throw new Error("Desktop release index is malformed");
  }
  const versions: DesktopReleaseCandidate[] = [];
  for (const entry of value.versions) {
    if (
      !isRecord(entry) ||
      !isTimestamp(entry.publishedAt) ||
      (channel === "staging"
        ? entry.channel !== "staging"
        : entry.channel !== "stable" && entry.channel !== "rc") ||
      !Array.isArray(entry.assets) ||
      entry.draft === true
    ) {
      throw new Error(
        "Desktop release index contains malformed release metadata",
      );
    }
    const assets: DesktopReleaseAsset[] = [];
    for (const asset of entry.assets) {
      if (
        !isRecord(asset) ||
        typeof asset.name !== "string" ||
        asset.name.length === 0 ||
        asset.name === "." ||
        asset.name === ".." ||
        /[\\/]/.test(asset.name) ||
        typeof asset.url !== "string" ||
        typeof asset.size !== "number" ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0 ||
        asset.url !==
          new URL(
            encodeURIComponent(asset.name),
            `${desktopCdnBase()}${encodeURIComponent(String(entry.version))}/`,
          ).href
      ) {
        throw new Error("Desktop release index contains a malformed asset");
      }
      assets.push({ name: asset.name, url: asset.url, size: asset.size });
    }
    const [release] = projectDesktopRelease(
      {
        tag_name: entry.tag,
        prerelease: entry.channel !== "stable",
        draft: false,
        assets,
      },
      channel === "staging" ? "staging" : "production",
    );
    if (
      release === undefined ||
      release.version !== entry.version ||
      versions.some((it) => it.version === release.version)
    ) {
      throw new Error(
        "Desktop release index contains an invalid desktop version",
      );
    }
    versions.push({ ...release, assets });
  }
  if (
    channel !== "staging" &&
    !versions.some(
      (it) =>
        it.version === value.stableHead &&
        it.tag === desktopReleaseTag(it.version) &&
        !it.version.includes("-"),
    )
  ) {
    throw new Error("Desktop release index does not retain its stable head");
  }
  return {
    stableHead: typeof value.stableHead === "string" ? value.stableHead : null,
    versions: versions.map((release) => ({
      ...release,
      origins: desktopReleaseOrigins(owner, repo, release, versions, false),
    })),
  };
}

function isTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
