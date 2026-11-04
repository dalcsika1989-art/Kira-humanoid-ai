# Android use and packaging

The supported path for an Android-only owner is to build in GitHub Actions using the browser instructions in [README](../README.md), then deploy the resulting client and server bundle to an authenticated HTTPS host. The Actions artifact is a web build, not an APK and not a deployment. Opening the HTML from a ZIP in Android Chrome does not start the API, and browser microphone access requires a secure origin.

The backend needs `GEMINI_API_KEY` in its server-side runtime secrets. Never put keys in the Android app, its settings, source files, the source ZIP or the web artifact. Test text, permission denial, recognition and voice playback in Chrome on a physical Android phone after hosting. Device speech support and installed voices vary.

LiveAvatar uses same-origin HttpOnly cookies: a cross-origin API base cannot provide it with the current client. A custom avatar, provider credentials and a complete live session test are required. The included portrait is static, not a rigged model.

## Future APK packaging

Capacitor configuration is present but no APK is built by the current workflow. A future cloud Android workflow needs an Android SDK/JDK, an initialized Capacitor `android/` project, native microphone permission and a reliable Android speech bridge. The current project does not demonstrate that Android WebView speech recognition works. Device testing and release signing are also required. A downloaded GitHub web build artifact should not be presented as an installable Android app.
