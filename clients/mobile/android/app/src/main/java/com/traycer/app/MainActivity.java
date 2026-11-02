package com.traycer.app;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // `cap sync` auto-registers only the npm plugins; a plugin that lives
        // in this app module is registered here, before the bridge loads.
        registerPlugin(AuthSessionPlugin.class);
        registerPlugin(SandboxArtifactsPlugin.class);
        registerPlugin(VoiceAudioPlugin.class);
        registerPlugin(WindowBackgroundPlugin.class);
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
    }
}
