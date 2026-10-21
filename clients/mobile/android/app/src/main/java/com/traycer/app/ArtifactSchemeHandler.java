package com.traycer.app;

import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.HashMap;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The WebView request thread waits for the first span; a bounded producer
 * feeds the rest through a pipe. Neither thread touches the app/native router. */
final class ArtifactSchemeHandler {
    private static final int SPAN_BYTES = 4 * 1024 * 1024;
    private static final long MAX_INTEGER = 9007199254740991L;
    private static final Pattern HOST = Pattern.compile("artifact-([a-z0-9_-]+)--([a-z0-9]+)\\.traycer-artifact\\.invalid");
    private static final Pattern RANGE = Pattern.compile("bytes=([0-9]+)-([0-9]*)");
    private static final String BASE_POLICY = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'";
    private final SandboxArtifactsPlugin plugin;
    private final Map<String, Pending> requests = new ConcurrentHashMap<>();
    private final Set<Transfer> transfers = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final ThreadPoolExecutor producers = new ThreadPoolExecutor(
        4, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32)
    );

    ArtifactSchemeHandler(SandboxArtifactsPlugin plugin) {
        this.plugin = plugin;
        producers.allowCoreThreadTimeOut(true);
    }

    private static final class Pending {
        final String id = UUID.randomUUID().toString();
        final CountDownLatch done = new CountDownLatch(1);
        volatile Reply reply;
    }

    private static final class Reply {
        final int status;
        final long offset;
        final long total;
        final String mediaType;
        final byte[] bytes;

        Reply(int status, long offset, long total, String mediaType, byte[] bytes) {
            this.status = status;
            this.offset = offset;
            this.total = total;
            this.mediaType = mediaType;
            this.bytes = bytes;
        }

        static Reply unavailable(int status) {
            return new Reply(status, 0, 0, "text/plain; charset=utf-8", new byte[0]);
        }

        boolean valid(long expectedOffset, int length) {
            return status == 200 && offset == expectedOffset && total >= offset &&
                bytes.length == Math.min(length, total - offset);
        }
    }

    private final class Transfer {
        final String mount;
        final String path;
        final AtomicBoolean cancelled = new AtomicBoolean();
        final AtomicReference<Pending> pending = new AtomicReference<>();
        volatile ArtifactInputStream stream;

        Transfer(String mount, String path) {
            this.mount = mount;
            this.path = path;
        }

        void cancel() {
            cancelled.set(true);
            Pending waiting = pending.getAndSet(null);
            if (waiting != null) cancelPending(waiting);
            transfers.remove(this);
        }
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        if (request.isForMainFrame()) return error(403);
        if (closed.get()) return error(503);
        // No mounted document exists before JS acknowledges its listeners.
        // A reserved host must still be answered locally in that interval.
        if (!plugin.isReady()) return error(404);
        String mount;
        String path;
        try {
            URI url = new URI(request.getUrl().toString());
            // URI.getHost rejects underscores, which artifact ids explicitly allow.
            String authority = url.getRawAuthority();
            Matcher host = HOST.matcher(authority == null ? "" : authority);
            if (!"https".equals(url.getScheme()) || !host.matches()) return error(400);
            mount = host.group(2);
            path = url.getPath();
            if (path == null) return error(400);
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty() || path.endsWith("/")) path += "index.html";
            if (path.contains("..") || path.contains("\\") || path.contains("\0") || path.contains("\uFFFD")) return error(400);
            for (String segment : path.split("/", -1)) if (segment.isEmpty()) return error(400);
        } catch (URISyntaxException exception) {
            return error(400);
        }
        String range = null;
        for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
            if (header.getKey().equalsIgnoreCase("Range")) range = header.getValue();
        }
        long offset = 0;
        int length = SPAN_BYTES;
        if (range != null) {
            Matcher match = RANGE.matcher(range);
            if (!match.matches()) return error(416);
            try {
                offset = Long.parseLong(match.group(1));
                long end = match.group(2).isEmpty() ? offset + length - 1 : Long.parseLong(match.group(2));
                if (offset > MAX_INTEGER || end > MAX_INTEGER || end < offset) return error(416);
                length = (int) Math.min(length, end - offset + 1);
            } catch (NumberFormatException exception) {
                return error(416);
            }
        }
        Transfer transfer = new Transfer(mount, path);
        transfers.add(transfer);
        Reply first = requestSpan(transfer, offset, length);
        if (first.status != 200) {
            transfer.cancel();
            return error(first.status);
        }
        if (range != null && offset >= first.total) {
            transfer.cancel();
            WebResourceResponse response = error(416);
            response.getResponseHeaders().put("Content-Range", "bytes */" + first.total);
            return response;
        }
        if (!first.valid(offset, length)) {
            transfer.cancel();
            return error(503);
        }
        Map<String, String> headers = headers(first.mediaType);
        if (range != null) {
            transfer.cancel();
            headers.put("Content-Range", "bytes " + offset + "-" + (offset + first.bytes.length - 1) + "/" + first.total);
            headers.put("Content-Length", String.valueOf(first.bytes.length));
            return response(first.mediaType, 206, headers, new ByteArrayInputStream(first.bytes));
        }
        headers.put("Content-Length", String.valueOf(first.total));
        try {
            ArtifactInputStream input = new ArtifactInputStream(transfer);
            transfer.stream = input;
            PipedOutputStream output = new PipedOutputStream(input);
            try {
                producers.execute(() -> produce(transfer, first, input, output));
            } catch (RejectedExecutionException exception) {
                input.close();
                output.close();
                return error(503);
            }
            if (closed.get()) input.close();
            return response(first.mediaType, 200, headers, input);
        } catch (IOException exception) {
            transfer.cancel();
            return error(503);
        }
    }

    private Reply requestSpan(Transfer transfer, long offset, int length) {
        if (closed.get() || transfer.cancelled.get()) return Reply.unavailable(503);
        Pending pending = new Pending();
        requests.put(pending.id, pending);
        transfer.pending.set(pending);
        synchronized (pending) {
            if (closed.get() || transfer.cancelled.get()) {
                cancelPending(pending);
            } else if (requests.containsKey(pending.id)) {
                JSObject event = new JSObject();
                event.put("requestId", pending.id);
                event.put("mountId", transfer.mount);
                event.put("path", transfer.path);
                event.put("offset", offset);
                event.put("length", length);
                plugin.emit("request", event);
            }
        }
        try {
            // A renderer can be waiting for a host-to-host file download.
            if (!pending.done.await(5, TimeUnit.MINUTES)) cancelPending(pending);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            cancelPending(pending);
        } finally {
            transfer.pending.compareAndSet(pending, null);
            requests.remove(pending.id, pending);
        }
        return pending.reply == null ? Reply.unavailable(503) : pending.reply;
    }

    void respond(PluginCall call) {
        String id = call.getString("requestId");
        if (id == null) return;
        Pending pending = requests.remove(id);
        if (pending == null) return;
        Reply reply = Reply.unavailable(503);
        if ("unavailable".equals(call.getString("kind"))) {
            reply = Reply.unavailable(Integer.valueOf(404).equals(call.getInt("status")) ? 404 : 503);
        } else if ("bytes".equals(call.getString("kind"))) {
            Long total = integer(call, "totalBytes");
            Long offset = integer(call, "offset");
            String mediaType = call.getString("mediaType");
            String base64 = call.getString("base64");
            if (total != null && offset != null && mediaType != null && !mediaType.isEmpty() &&
                mediaType.length() <= 1024 && !Pattern.compile("[\\x00-\\x1f\\x7f]").matcher(mediaType).find() &&
                base64 != null && base64.length() <= ((SPAN_BYTES + 2) / 3) * 4) {
                try {
                    byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
                    if (bytes.length <= SPAN_BYTES) reply = new Reply(200, offset, total, mediaType, bytes);
                } catch (IllegalArgumentException exception) {
                    // A malformed reply settles the waiter as unavailable.
                }
            }
        }
        pending.reply = reply;
        pending.done.countDown();
    }

    private void cancelPending(Pending pending) {
        synchronized (pending) {
            if (!requests.remove(pending.id, pending)) return;
            pending.done.countDown();
            JSObject event = new JSObject();
            event.put("requestId", pending.id);
            plugin.emit("cancel", event);
        }
    }

    private void produce(Transfer transfer, Reply first, ArtifactInputStream input, PipedOutputStream output) {
        try {
            Reply span = first;
            long position = 0;
            while (!transfer.cancelled.get()) {
                output.write(span.bytes);
                position += span.bytes.length;
                if (position >= first.total) break;
                span = requestSpan(transfer, position, SPAN_BYTES);
                if (!span.valid(position, SPAN_BYTES) || span.total != first.total || !span.mediaType.equals(first.mediaType)) {
                    throw new IOException("Artifact stream unavailable");
                }
            }
        } catch (IOException exception) {
            input.failure.compareAndSet(null, exception);
        } finally {
            // Publish failure before closing the writer: EOF must not race the
            // failure flag and make a truncated stream look successful.
            try { output.close(); } catch (IOException exception) { input.failure.compareAndSet(null, exception); }
            transfer.cancel();
        }
    }

    private final class ArtifactInputStream extends PipedInputStream {
        final AtomicReference<IOException> failure = new AtomicReference<>();
        private final Transfer transfer;

        ArtifactInputStream(Transfer transfer) {
            super(64 * 1024);
            this.transfer = transfer;
        }

        @Override
        public synchronized int read() throws IOException {
            int result = super.read();
            if (result == -1 && failure.get() != null) throw failure.get();
            return result;
        }

        @Override
        public synchronized int read(byte[] buffer, int offset, int length) throws IOException {
            int result = super.read(buffer, offset, length);
            if (result == -1 && failure.get() != null) throw failure.get();
            return result;
        }

        @Override
        public void close() throws IOException {
            transfer.cancel();
            super.close();
        }
    }

    void close() {
        closed.set(true);
        for (Transfer transfer : transfers) {
            transfer.cancel();
            if (transfer.stream != null) {
                try { transfer.stream.close(); } catch (IOException ignored) { }
            }
        }
        producers.shutdownNow();
    }

    private static Long integer(PluginCall call, String name) {
        // Capacitor getDouble omits Long; JSON uses Long for files above 2 GiB.
        Object raw = call.getData().opt(name);
        if (!(raw instanceof Number)) return null;
        double value = ((Number) raw).doubleValue();
        return Double.isFinite(value) && value >= 0 && value <= MAX_INTEGER && value == Math.floor(value)
            ? ((Number) raw).longValue() : null;
    }

    private static Map<String, String> headers(String mediaType) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", mediaType);
        headers.put("Content-Security-Policy", BASE_POLICY);
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return headers;
    }

    private static WebResourceResponse response(String mediaType, int status, Map<String, String> headers, java.io.InputStream stream) {
        // Pass the full Content-Type header separately: the constructor's MIME
        // argument must not contain its charset parameter.
        String mime = mediaType.split(";", 2)[0].trim();
        return new WebResourceResponse(mime, null, status, status == 206 ? "Partial Content" : "OK", headers, stream);
    }

    private static WebResourceResponse error(int status) {
        return new WebResourceResponse("text/plain", "utf-8", status, "Artifact unavailable", headers("text/plain; charset=utf-8"),
            new ByteArrayInputStream("Artifact unavailable".getBytes(StandardCharsets.UTF_8)));
    }
}
