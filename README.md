# KIRA

KIRA is a mobile-first AI companion project with a reference-based portrait, Gemini server gateway, local conversation memory, browser voice adapters and an optional LiveAvatar integration. The portrait is a static image, not a rigged 3D character. Animated video requires a provisioned custom LiveAvatar, provider credentials and successful device testing; this integration has not been verified with a live provider.

## Build in GitHub from an Android phone

No computer or local development tools are needed. You need a GitHub account with Actions and Codespaces enabled for your account. The source ZIP is a separate download from the finished Actions artifact and should contain the project files at its top level, including `.github/workflows/build.yml`. Do **not** put API keys in the ZIP.

1. Download the KIRA source ZIP to your phone; leave it named `kira-source.zip`.
2. In Chrome open [github.com/new](https://github.com/new), sign in, create a new **private** repository, and select **Add a README file** before creating it.
3. In your repository tap **Add file → Upload files**. Select `kira-source.zip` in your phone's file picker, then tap **Commit changes**. If the controls are hidden, choose Chrome's **⋮ → Desktop site**.
4. On the repository page tap **Code → Codespaces → Create codespace on main**. Wait for the browser-based cloud workspace to start. This runs on GitHub, not on your phone. Codespaces availability and free usage limits depend on your account.
5. In the Codespace menu open **Terminal → New Terminal**. Enter each command separately:

   ```bash
   unzip -o kira-source.zip
   rm -f kira-source.zip
   git add -A
   git commit -m "Add KIRA source and cloud build"
   git push
   ```

   The ZIP must extract into the repository root: after extraction `package.json`, `src/`, and `.github/` must be at the top level. The `rm` command removes the ZIP from the current branch so Actions builds the source files; the original ZIP still exists in the previous commit's history. The ZIP must contain no secrets.
6. In GitHub return to your repository and open **Actions**. If prompted, enable Actions for the repository. The push should start **Build KIRA** automatically. To start it manually, select **Build KIRA → Run workflow**, choose `main`, and tap the green **Run workflow** button. Refresh and open the newest run.
7. Wait for a green check. On the run's summary page, scroll to **Artifacts** and tap **kira-web-build** to download the ZIP. You may need to sign in and use Chrome's desktop-site view. Artifacts expire after 14 days. If the run is red, tap the failed step to read its log; a failed run has no successful build artifact.

The build ZIP contains `client/` (web files) and `server/index.js` (a Worker-compatible server bundle). It is **not an APK or a deployed website**. Opening the downloaded HTML as a local file on Android does not provide the Gemini backend or secure microphone access. To actually use KIRA, host the application and API together on an authenticated HTTPS service and configure runtime secrets there. GitHub Actions produces build files; it does not publish them or configure a production service. Voice recognition and playback require Android Chrome and device testing.

## Credentials

The Actions build requires **no API keys**. Keep `GEMINI_API_KEY`, `LIVEAVATAR_API_KEY`, and `LIVEAVATAR_AVATAR_ID` in the runtime host's server-side secret configuration. Never add them to source, the browser settings, the ZIP or GitHub build artifacts. GitHub repository secrets can be added under **Settings → Secrets and variables → Actions → New repository secret**, but doing that alone does not configure a separate deployment or enable Gemini. A future deployment workflow must explicitly use the secret on the server. Rotate a credential that has been shared publicly.

## Features and limits

- The gateway calls Google's Gemini API with conversation history, language and personality, with validation and provider error handling. A valid API key, available model, quota, an HTTPS host and a live provider test are required.
- Browser voice uses speech recognition and device speech synthesis where supported; voices and recognition vary by Android device and language. Speech output does not animate the static portrait.
- Conversation history and remembered context are stored on the device rather than synced; clearing site data removes them.
- The LiveAvatar adapter is an integration point for streaming a provisioned custom avatar, not proof of a working animated avatar. It requires a paid avatar and credentials, same-origin HTTPS hosting, and a real provider and device test. See [avatar setup](docs/AVATAR.md).
- The build workflow tests and builds web files. Android APK packaging, native speech support and physical-device testing remain separate work; see [Android notes](docs/ANDROID.md).

## Developer commands

For contributors with Node.js 22.14+:

```bash
npm install
npm test
npm run build
python3 scripts/serve-secure.py
```

The launcher prompts for a server-side key without saving it; run `npm run dev -- --host 0.0.0.0` in another terminal. Vite proxies `/api` to the Node server. Use HTTPS or localhost for browser microphone access. For production, put the API behind HTTPS and authentication; CORS and the in-process limiter do not replace authentication.

See [verification](docs/VERIFICATION.md), [architecture](docs/ARCHITECTURE.md), and [third-party notices](docs/THIRD_PARTY.md). Never commit `.env`, dependencies, build output, signing keys, or private configuration.
