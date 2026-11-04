# Verification and release gates

The final delivery report states actual current test and build results. The repository contains a GitHub Actions workflow named **Build KIRA** that installs dependencies, runs `npm test`, builds the client and Worker bundle, and uploads `kira-web-build` if successful. Adding a workflow does not prove it has run. Check the run's logs and green status in GitHub Actions.

The server tests use mocked Gemini and LiveAvatar responses. Passing them verifies parts of the gateway's request validation, context forwarding, error handling and session boundaries; it does not validate a real Google key, model availability, provider account or external avatar service. The React interface and Android browser/device interactions require separate testing.

Still required before a release: a working hosted HTTPS API with server-only credentials; a real Gemini request; physical Android testing for all requested voice languages, permissions and interruption; custom licensed avatar provisioning and an end-to-end LiveAvatar test; production authentication, appropriate rate limits and secure deployment; and separate APK packaging and native voice validation if an APK is desired. The static portrait must not be described as an animated 3D model.
