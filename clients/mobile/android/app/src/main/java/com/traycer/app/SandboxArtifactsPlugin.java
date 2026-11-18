package com.traycer.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Only the app's guarded Capacitor bridge can supply artifact bytes. */
@CapacitorPlugin(name = "SandboxArtifacts")
public class SandboxArtifactsPlugin extends Plugin {
    private ArtifactSchemeHandler artifacts;
    private volatile boolean listening;

    @Override
    public void load() {
        artifacts = new ArtifactSchemeHandler(this);
        // Plugin load precedes loadWebView. Its client inherits the patched
        // app-origin and native-route guards; artifact hosts have no app routes.
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Capacitor otherwise sends every non-app host to ACTION_VIEW,
                // including subframes. Artifact documents stay in their frame.
                if (ArtifactRequestRouter.owns(request.getUrl().toString())) {
                    return request.isForMainFrame();
                }
                return super.shouldOverrideUrlLoading(view, request);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return ArtifactRequestRouter.intercept(
                    request.getUrl().toString(),
                    () -> artifacts.intercept(request),
                    () -> super.shouldInterceptRequest(view, request)
                );
            }
        });
    }

    @PluginMethod
    public void ready(PluginCall call) {
        // Executed on Capacitor's plugin queue after both addListener calls.
        if (!hasListeners("request") || !hasListeners("cancel")) {
            call.reject("Artifact listeners are unavailable");
            return;
        }
        listening = true;
        call.resolve();
    }

    boolean isReady() { return listening; }

    @PluginMethod
    public void respond(PluginCall call) {
        artifacts.respond(call);
        call.resolve();
    }

    void emit(String event, JSObject data) {
        // Listener registration and delivery share Capacitor's plugin thread.
        bridge.execute(() -> notifyListeners(event, data));
    }

    @Override
    protected void handleOnDestroy() {
        listening = false;
        artifacts.close();
    }
}
