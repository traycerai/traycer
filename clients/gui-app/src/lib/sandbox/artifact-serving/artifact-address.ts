import type { SandboxArtifactBridge } from "@traycer-clients/shared/platform/sandbox-artifacts";

export interface ArtifactAddress {
  readonly mountId: string;
  readonly artifactId: string;
  /** Full decoded path relative to the artifacts tree root. */
  readonly path: string;
}

const ARTIFACT_ID = /^[a-z0-9_-]+$/;
const MOUNT_ID = /^[a-z0-9]+$/;
const ANDROID_HOST_SUFFIX = ".traycer-artifact.invalid";
const MOUNT_PATH_PREFIX = /^\/m\/([a-z0-9]+)(\/.*)?$/;

/** Manifest paths are decoded once, at the URL boundary, never at lookup. */
export function isArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.includes("\\") &&
    !Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    path
      .split("/")
      .every((segment) => segment !== "" && !segment.startsWith("."))
  );
}

/**
 * The desktop serves one site per artifact, `artifact-<artifactId>`, and
 * names the mount in the path as `/m/<mountId>`: a browser gives each site a
 * renderer process, so every frame of an artifact (all of a canvas's boards)
 * shares one. The mobile shells name the mount in the host instead.
 */
function mountInPath(
  scheme: string,
  authority: string,
  rawPath: string,
): { readonly mountId: string; readonly rawPath: string } | null {
  const match = MOUNT_PATH_PREFIX.exec(rawPath);
  if (
    scheme !== "traycer-sandbox" ||
    !ARTIFACT_ID.test(authority) ||
    match === null
  )
    return null;
  return {
    mountId: match[1],
    rawPath: typeof match[2] === "string" ? match[2] : "/",
  };
}

export function parseArtifactAddress(url: string): ArtifactAddress | null {
  // URL() removes literal and encoded dot segments before callers can reject
  // them. Inspect the original path and authority instead.
  const match =
    /^([A-Za-z][A-Za-z0-9+.-]*):\/\/artifact-([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(
      url,
    );
  if (match === null) return null;
  const scheme = match[1];
  let authority = match[2];
  if (scheme === "https") {
    if (!authority.endsWith(ANDROID_HOST_SUFFIX)) return null;
    authority = authority.slice(0, -ANDROID_HOST_SUFFIX.length);
  } else if (scheme !== "traycer-sandbox" && scheme !== "traycer-artifact") {
    return null;
  }
  let rawPath = typeof match[3] === "string" ? match[3] : "/";
  const delimiter = authority.lastIndexOf("--");
  let artifactId = authority.slice(0, delimiter);
  let mountId = authority.slice(delimiter + 2);
  if (
    delimiter < 1 ||
    !ARTIFACT_ID.test(artifactId) ||
    !MOUNT_ID.test(mountId)
  ) {
    const inPath = mountInPath(scheme, authority, rawPath);
    if (inPath === null) return null;
    artifactId = authority;
    ({ mountId, rawPath } = inPath);
  }
  let path: string;
  try {
    path = decodeURIComponent(rawPath.slice(1));
  } catch {
    return null;
  }
  if (path === "" || path.endsWith("/")) path += "index.html";
  return isArtifactPath(path) ? { artifactId, mountId, path } : null;
}

export interface ArtifactAddressParts {
  readonly origin: string;
  readonly artifactId: string;
  readonly mountId: string;
  readonly treePath: string;
  readonly path: string;
}

/** An origin that names only the artifact is a site all its mounts share. */
function namesMount(origin: string): boolean {
  return parseArtifactAddress(origin) !== null;
}

/**
 * Whether the shell serves every mount of this artifact from one site. A
 * browser gives a site one renderer process, so the artifact's frames (all of
 * a canvas's boards) then share one, apart from the app's own.
 */
export function artifactMountsShareSite(
  bridge: Pick<SandboxArtifactBridge, "artifactOrigin">,
  artifactId: string,
): boolean {
  // Any mount id will do: the question is whether the origin names one.
  return !namesMount(bridge.artifactOrigin({ artifactId, mountId: "0" }));
}

/**
 * Keeping the folder in the URL lets the browser resolve parent references.
 * On a site the artifact's mounts share, the mount goes in the path.
 */
export function buildArtifactAddress(address: ArtifactAddressParts): string {
  const { origin, artifactId, mountId, treePath, path } = address;
  const relativePath = path === "" ? "index.html" : path;
  const fullPath =
    treePath === "" ? relativePath : `${treePath}/${relativePath}`;
  const mountPrefix = namesMount(origin) ? "" : `/m/${mountId}`;
  const url = `${origin}${mountPrefix}/${fullPath.split("/").map(encodeURIComponent).join("/")}`;
  const parsed = parseArtifactAddress(url);
  if (
    !/^[^:/?#]+:\/\/[^/?#]+$/.test(origin) ||
    parsed === null ||
    parsed.artifactId !== artifactId ||
    parsed.mountId !== mountId ||
    (treePath !== "" && !isArtifactPath(treePath)) ||
    !isArtifactPath(relativePath) ||
    !isArtifactPath(fullPath)
  ) {
    throw new Error("Invalid artifact address");
  }
  return url;
}

export function newMountId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
