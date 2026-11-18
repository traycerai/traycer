import Capacitor
import WebKit

/// JSON-only transport to the main app document. SandboxBridgeGuard remains
/// the authority for who can call this plugin; artifact frames cannot call it.
@objc(SandboxArtifactsPlugin)
public class SandboxArtifactsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SandboxArtifactsPlugin"
    public let jsName = "SandboxArtifacts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise),
    ]
    weak var handler: ArtifactSchemeHandler?

    @objc func ready(_ call: CAPPluginCall) {
        // Capacitor invokes methods on its serial bridge queue, after the two
        // addListener calls. Their JS promises only acknowledge callback ids.
        guard bridge is CapacitorBridge, hasListeners("request"), hasListeners("cancel") else {
            call.reject("Artifact listeners are unavailable")
            return
        }
        call.resolve()
    }

    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.handler?.respond(call)
            call.resolve()
        }
    }

    private func emit(_ event: String, data: JSObject) {
        // Registration, removal and delivery must share the listener dictionary's
        // queue. WK tasks and the handler's request maps remain on main.
        (bridge as? CapacitorBridge)?.dispatchQueue.async { [weak self] in
            self?.notifyListeners(event, data: data)
        }
    }

    func request(_ data: JSObject) { emit("request", data: data) }
    func cancel(_ requestId: String) { emit("cancel", data: ["requestId": requestId]) }
}

/// WebKit callbacks and the state below stay on the main queue. Only one span
/// per task is in flight; stop removes it before JS can deliver a late reply.
final class ArtifactSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "traycer-artifact"
    private static let spanBytes = 4 * 1024 * 1024
    private static let maxInteger = 9_007_199_254_740_991
    private static let basePolicy = "default-src * traycer-artifact: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'"
    weak var plugin: SandboxArtifactsPlugin?

    private final class Transfer {
        let task: WKURLSchemeTask
        let url: URL
        let mountId: String
        let path: String
        let ranged: Bool
        let length: Int
        var position: Int
        var total: Int?
        var mediaType: String?
        var requestId: String?
        var timeout: DispatchWorkItem?

        init(task: WKURLSchemeTask, url: URL, mountId: String, path: String, ranged: Bool, offset: Int, length: Int) {
            self.task = task
            self.url = url
            self.mountId = mountId
            self.path = path
            self.ranged = ranged
            self.position = offset
            self.length = length
        }
    }
    private var transfers: [ObjectIdentifier: Transfer] = [:]
    private var requests: [String: Transfer] = [:]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == Self.scheme, parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host, Self.matches(host, "^artifact-[a-z0-9_-]+--[a-z0-9]+$"),
              let separator = host.range(of: "--", options: .backwards),
              Self.matches(String(host[host.index(host.startIndex, offsetBy: 9)..<separator.lowerBound]), "^[a-z0-9_-]+$"),
              Self.matches(String(host[separator.upperBound...]), "^[a-z0-9]+$") else {
            fail(urlSchemeTask, status: 400, message: "Invalid artifact URL", contentRange: nil)
            return
        }
        guard var path = parts.percentEncodedPath.removingPercentEncoding else {
            fail(urlSchemeTask, status: 400, message: "Invalid artifact path", contentRange: nil)
            return
        }
        if path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty || path.hasSuffix("/") { path += "index.html" }
        guard !path.contains(".."), !path.contains("\\"), !path.contains("\0"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains("") else {
            fail(urlSchemeTask, status: 400, message: "Invalid artifact path", contentRange: nil)
            return
        }
        let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
        var offset = 0
        var length = Self.spanBytes
        if let range {
            let values = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            guard Self.matches(range, "^bytes=[0-9]+-[0-9]*$"), values.count == 2,
                  let start = Int(values[0]), start <= Self.maxInteger else {
                fail(urlSchemeTask, status: 416, message: "Invalid artifact range", contentRange: nil)
                return
            }
            let end = values[1].isEmpty ? start + length - 1 : Int(values[1])
            guard let end, end <= Self.maxInteger, end >= start else {
                fail(urlSchemeTask, status: 416, message: "Invalid artifact range", contentRange: nil)
                return
            }
            offset = start
            length = min(length, end - start + 1)
        }
        let transfer = Transfer(task: urlSchemeTask, url: url, mountId: String(host[separator.upperBound...]), path: path,
                                ranged: range != nil, offset: offset, length: length)
        transfers[ObjectIdentifier(urlSchemeTask)] = transfer
        requestSpan(transfer)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        guard let transfer = transfers.removeValue(forKey: ObjectIdentifier(urlSchemeTask)) else { return }
        cancelSpan(transfer)
    }

    private func requestSpan(_ transfer: Transfer) {
        guard let plugin else {
            finishError(transfer, status: 503, message: "Artifact bridge unavailable", contentRange: nil)
            return
        }
        let id = UUID().uuidString
        transfer.requestId = id
        requests[id] = transfer
        let timeout = DispatchWorkItem { [weak self, weak transfer] in
            guard let self, let transfer, self.requests[id] != nil else { return }
            self.cancelSpan(transfer)
            self.finishError(transfer, status: 503, message: "Artifact request timed out", contentRange: nil)
        }
        transfer.timeout = timeout
        // The first span may wait for a file to download from another host.
        DispatchQueue.main.asyncAfter(deadline: .now() + 300, execute: timeout)
        plugin.request(["requestId": id, "mountId": transfer.mountId, "path": transfer.path,
                        "offset": transfer.position, "length": transfer.length])
    }

    func respond(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), let transfer = requests.removeValue(forKey: id) else { return }
        transfer.timeout?.cancel()
        transfer.timeout = nil
        transfer.requestId = nil
        if call.getString("kind") == "unavailable" {
            finishError(transfer, status: call.getInt("status") == 404 ? 404 : 503,
                        message: "Artifact unavailable", contentRange: nil)
            return
        }
        guard call.getString("kind") == "bytes",
              let total = Self.integer(call, "totalBytes"),
              let offset = Self.integer(call, "offset"), offset == transfer.position,
              let mediaType = call.getString("mediaType"), !mediaType.isEmpty, mediaType.utf8.count <= 1024,
              !mediaType.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let base64 = call.getString("base64"), base64.utf8.count <= ((Self.spanBytes + 2) / 3) * 4,
              let bytes = Data(base64Encoded: base64) else {
            finishError(transfer, status: 503, message: "Invalid artifact span", contentRange: nil)
            return
        }
        if transfer.ranged && transfer.position >= total {
            finishError(transfer, status: 416, message: "Artifact range outside file", contentRange: "bytes */\(total)")
            return
        }
        guard total >= offset, bytes.count == min(transfer.length, total - offset),
              transfer.total == nil || (transfer.total == total && transfer.mediaType == mediaType) else {
            finishError(transfer, status: 503, message: "Invalid artifact span", contentRange: nil)
            return
        }
        if transfer.total == nil {
            var headers = Self.headers(mediaType)
            headers["Content-Length"] = String(transfer.ranged ? bytes.count : total)
            if transfer.ranged {
                headers["Content-Range"] = "bytes \(offset)-\(offset + bytes.count - 1)/\(total)"
            }
            guard let response = HTTPURLResponse(url: transfer.url, statusCode: transfer.ranged ? 206 : 200,
                                                 httpVersion: nil, headerFields: headers) else {
                finishError(transfer, status: 503, message: "Invalid artifact response", contentRange: nil)
                return
            }
            transfer.total = total
            transfer.mediaType = mediaType
            transfer.task.didReceive(response)
        }
        if !bytes.isEmpty { transfer.task.didReceive(bytes) }
        transfer.position += bytes.count
        if transfer.ranged || transfer.position >= total {
            transfers.removeValue(forKey: ObjectIdentifier(transfer.task))
            transfer.task.didFinish()
        } else {
            requestSpan(transfer)
        }
    }

    private func cancelSpan(_ transfer: Transfer) {
        transfer.timeout?.cancel()
        transfer.timeout = nil
        if let id = transfer.requestId {
            requests.removeValue(forKey: id)
            transfer.requestId = nil
            plugin?.cancel(id)
        }
    }

    private func finishError(_ transfer: Transfer, status: Int, message: String, contentRange: String?) {
        transfers.removeValue(forKey: ObjectIdentifier(transfer.task))
        cancelSpan(transfer)
        if transfer.total != nil {
            // Headers have already left; truncated bytes must never look complete.
            transfer.task.didFailWithError(NSError(domain: "TraycerArtifact", code: status))
        } else {
            fail(transfer.task, status: status, message: message, contentRange: contentRange)
        }
    }

    private func fail(_ task: WKURLSchemeTask, status: Int, message: String, contentRange: String?) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var headers = Self.headers("text/plain; charset=utf-8")
        headers["Content-Range"] = contentRange
        if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers) {
            task.didReceive(response)
            task.didReceive(Data(message.utf8))
            task.didFinish()
        } else {
            task.didFailWithError(URLError(.badServerResponse))
        }
    }

    private static func headers(_ mediaType: String) -> [String: String] {
        ["Content-Type": mediaType, "Content-Security-Policy": basePolicy, "X-Content-Type-Options": "nosniff",
         "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"]
    }

    private static func integer(_ call: CAPPluginCall, _ name: String) -> Int? {
        guard let value = call.getDouble(name), value.isFinite, value >= 0,
              value <= Double(maxInteger), value.rounded(.down) == value else { return nil }
        return Int(value)
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}
