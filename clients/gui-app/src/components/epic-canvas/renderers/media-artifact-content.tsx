import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  ArtifactServer,
  type ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving/artifact-server";
import { mountArtifact } from "@/lib/sandbox/artifact-serving/mount-registry";
import { buildArtifactAddress } from "@/lib/sandbox/artifact-serving/artifact-address";
import { Button } from "@/components/ui/button";

type MediaKind = "audio" | "video";
type MediaObject = Pick<
  ArtifactObjectRef,
  "sha256" | "byteLength" | "mediaType" | "status"
>;

export function MediaArtifactContent(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly object: MediaObject;
  readonly kind: MediaKind;
  readonly readSpan: ArtifactReadSpan;
}) {
  const runnerHost = useRunnerHostOrNull();
  const bridge = runnerHost?.sandboxArtifacts ?? null;
  const source = useMediaSource(props, bridge !== null);
  if (source === null) return <MediaStatus loading />;
  return source === "host" && runnerHost !== null && bridge !== null ? (
    <NativeMediaContent {...props} runnerHost={runnerHost} />
  ) : (
    <CloudMediaContent {...props} />
  );
}

type MediaSource = "host" | "cloud";

/**
 * Where this viewing takes its bytes from, settled once so an object that
 * publishes while it plays keeps its mount.
 *
 * A published object's bytes live in the cloud, and every host mirrors them
 * to its own disk in the background. The player should never wait on that
 * mirror, and never route bytes through a machine whose disk is not the
 * viewer's: relaying spans through another host hands the player base64
 * unary replies under the 30 s remote deadline, which is how a 5 MB recording
 * became unplayable on a bad link. So another machine's host answers with
 * its cloud URL, and this machine's host is asked for one byte: the byte
 * means the file is on its disk and plays from there for free; any other
 * answer, a failed probe, or no answer within {@link PROBE_DEADLINE_MS}
 * means it plays from the cloud this time while the host finishes fetching
 * it for the next. The deadline matters because a host asked for a sha it
 * does not hold starts the fetch and holds the reply up to 3 s before saying
 * so. An unpublished object exists only on its host.
 */
const PROBE_DEADLINE_MS = 1_000;

function useMediaSource(
  props: {
    readonly epicId: string;
    readonly hostId: string;
    readonly object: MediaObject;
  },
  hasBridge: boolean,
): MediaSource | null {
  // `null` until the binding resolves, which is not yet "another machine".
  const localHostId = useReactiveLocalHostId();
  const isLocalHost = localHostId !== null && props.hostId === localHostId;
  const [source, setSource] = useState<MediaSource | null>(() => {
    if (!hasBridge) return "cloud";
    if (props.object.status !== "published") return "host";
    return localHostId !== null && !isLocalHost ? "cloud" : null;
  });
  const client = useHostClientForHostId(props.hostId);
  // Each viewing asks afresh: an earlier viewing's cached answer, or its probe
  // still in flight, says nothing about whether the file is on disk now.
  const [probeViewing] = useState(() => crypto.randomUUID());
  const probe = useHostQuery({
    client,
    method: "epic.readArtifactObject",
    params: {
      epicId: props.epicId,
      sha256: props.object.sha256,
      want: { kind: "range", offset: 0, length: 1 },
    },
    cacheKeyIdentity: [probeViewing],
    options: { enabled: source === null && isLocalHost, staleTime: 0 },
  });
  useEffect(() => {
    if (source !== null) return;
    const timer = setTimeout(() => setSource("cloud"), PROBE_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [source]);
  // Latched during render from the first answer: the method's policy keeps
  // polling a `downloading` answer, and a later "bytes" must not move a
  // playing element off the cloud.
  const answer = probe.data?.kind;
  if (source === null) {
    if (localHostId !== null && !isLocalHost) {
      setSource("cloud");
    } else if (isLocalHost && (answer !== undefined || probe.isError)) {
      setSource(answer === "bytes" ? "host" : "cloud");
    }
  }
  return source;
}

function NativeMediaContent(props: {
  readonly object: MediaObject;
  readonly kind: MediaKind;
  readonly readSpan: ArtifactReadSpan;
  readonly runnerHost: IRunnerHost;
}) {
  const { sha256, byteLength, mediaType } = props.object;
  const { readSpan, runnerHost } = props;
  const source = useMemo(
    () => ({ sha256, byteLength, mediaType, readSpan, runnerHost }),
    [sha256, byteLength, mediaType, readSpan, runnerHost],
  );
  const [mounted, setMounted] = useState<{
    readonly source: typeof source;
    readonly url: string | null;
  } | null>(null);
  useEffect(() => {
    const bridge = runnerHost.sandboxArtifacts;
    if (bridge === null) return;
    // A fixed non-document path avoids extension-based HTML composition.
    // Shared block reads live until this mount ends, including download retries.
    const server = new ArtifactServer({
      treePath: "",
      manifest: { files: { media: { sha256, byteLength, mediaType } } },
      readSpan,
      document: {
        policySource: bridge.policySource,
        csp: null,
        theme: {
          appliesToRoot: false,
          colorScheme: "light",
          background: null,
          variables: {},
        },
        nonce: "",
        shortcuts: [],
      },
    });
    const mount = mountArtifact(runnerHost, server);
    const artifactId = `media-${sha256}`;
    const url = buildArtifactAddress({
      origin: bridge.artifactOrigin({ artifactId, mountId: mount.mountId }),
      artifactId,
      mountId: mount.mountId,
      treePath: "",
      path: "media",
    });
    let active = true;
    void mount.ready.then(
      () => {
        if (active) setMounted({ source, url });
      },
      () => {
        mount.dispose();
        if (active) setMounted({ source, url: null });
      },
    );
    return () => {
      active = false;
      mount.dispose();
    };
  }, [source, runnerHost, sha256, byteLength, mediaType, readSpan]);
  if (mounted?.source !== source) return <MediaStatus loading />;
  return mounted.url === null ? (
    <MediaStatus loading={false} />
  ) : (
    <MediaElement kind={props.kind} url={mounted.url} onRetry={null} />
  );
}

/** A browser without a native artifact bridge can stream published objects. */
function CloudMediaContent(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly object: MediaObject;
  readonly kind: MediaKind;
}) {
  const client = useHostClientForHostId(props.hostId);
  const query = useHostQuery({
    client,
    method: "epic.readArtifactObject",
    params: {
      epicId: props.epicId,
      sha256: props.object.sha256,
      want: { kind: "url" },
    },
    cacheKeyIdentity: undefined,
    options: {
      enabled: props.object.status === "published",
      staleTime: 0,
    },
  });
  const expiresAt = query.data?.kind === "url" ? query.data.expiresAt : null;
  const { refetch } = query;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => void refetch(),
      Math.max(1_000, (expiresAt - Date.now()) * 0.8),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, refetch]);
  return query.data?.kind === "url" ? (
    <MediaElement
      kind={props.kind}
      url={query.data.url}
      onRetry={async () => {
        await refetch({ throwOnError: true });
      }}
    />
  ) : (
    <MediaStatus
      loading={
        (query.isPending &&
          props.object.status !== "local-only" &&
          props.object.status !== "failed") ||
        query.data?.kind === "downloading"
      }
    />
  );
}

function MediaStatus({ loading }: { readonly loading: boolean }) {
  return (
    <p role="status" className="p-4 text-muted-foreground">
      {loading
        ? "Loading media…"
        : "This file can't be played here. Save it to open it."}
    </p>
  );
}

function MediaElement({
  kind,
  url,
  onRetry,
}: {
  readonly kind: MediaKind;
  readonly url: string;
  readonly onRetry: (() => Promise<void>) | null;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // A renewed cloud URL must not restart a recording at zero.
  const playback = useRef({ time: 0, playing: false });
  const retry = async (): Promise<void> => {
    setRetrying(true);
    try {
      await onRetry?.();
      setFailedUrl(null);
    } catch {
      // Keep the retry action available when renewing a cloud URL fails.
    } finally {
      setRetrying(false);
    }
  };
  if (failedUrl === url)
    return (
      <div className="flex flex-col items-center gap-2 p-4">
        <p role="status" className="text-muted-foreground">
          Couldn't play this file. Retry, or save it to open it.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => void retry()}
        >
          Retry
        </Button>
      </div>
    );
  const mediaProps = {
    src: url,
    controls: true,
    preload: "metadata",
    onError: () => setFailedUrl(url),
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => {
      if (event.currentTarget.readyState >= 1)
        playback.current.time = event.currentTarget.currentTime;
    },
    onPlay: () => {
      playback.current.playing = true;
    },
    onPause: () => {
      playback.current.playing = false;
    },
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      event.currentTarget.currentTime = playback.current.time;
      if (playback.current.playing)
        void event.currentTarget.play().catch(() => undefined);
    },
  };
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      {kind === "video" ? (
        <video {...mediaProps} className="max-h-full max-w-full">
          <track kind="captions" />
        </video>
      ) : (
        <audio {...mediaProps}>
          <track kind="captions" />
        </audio>
      )}
    </div>
  );
}
