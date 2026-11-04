# Professional avatar provisioning

The included image establishes KIRA's visual identity. It cannot blink, speak, rotate its head or provide accurate eye tracking by itself. No rigged 3D character is bundled or claimed.

## Current integration: LiveAvatar LITE

The existing adapter uses LiveAvatar as an audio renderer. Text comes from the application's Gemini chat gateway, preserving the same history, language and personality. Server-side Gemini TTS produces 24 kHz mono PCM; the browser sends that audio to the LITE control socket while LiveKit receives synchronized avatar video/audio. This is streamed animated video, not an editable 3D skeleton.

To enable it:

1. Obtain LiveAvatar API access and a paid custom-avatar entitlement. Create a custom KIRA avatar from the clean portrait asset or a suitable licensed higher-resolution version. Check the provider's consent and asset-usage requirements.
2. Set `LIVEAVATAR_API_KEY` and `LIVEAVATAR_AVATAR_ID` in the server's secret manager. Keep `GEMINI_API_KEY` server-side as well.
3. Check access/quota for `GEMINI_TTS_MODEL` (default `gemini-3.8-flash-tts`) and choose a supported `GEMINI_TTS_VOICE` (default `Kore`).
4. Serve client and gateway from the same HTTPS origin. The encrypted HttpOnly avatar cookie uses `SameSite=Strict`; a separate native application origin is not supported by this browser-cookie adapter.
5. Connect the avatar in the application and verify video/audio, English/Hungarian/German pronunciation, long responses, interruption, disconnect cleanup and five-minute expiry on a real Android device.

Missing API access, custom avatar and TTS model entitlement are precise external blockers. The adapter has mocked boundary tests but has not been verified with a paid session. Provider output determines how closely facial appearance and motion match the reference; do not promise arbitrary eye direction or custom facial rig control from the video API.

Sources checked for the integration:

- [LiveAvatar LITE lifecycle](https://docs.liveavatar.com/docs/lite-mode/lifecycle)
- [LiveAvatar LITE events](https://docs.liveavatar.com/docs/lite-mode/events)
- [Create session token](https://docs.liveavatar.com/api-reference/sessions/create-session-token)
- [Start session](https://docs.liveavatar.com/api-reference/sessions/start-session)
- [Avatar requirements](https://docs.liveavatar.com/docs/core-concepts/avatars)
- [Google speech generation](https://aistudio.google.com/docs/speech-generation)

## Alternative: actual 3D KIRA

Commission or license a realistic adult female GLB matching KIRA, including long dark hair, blue eyes, skin textures, cybernetic neck/shoulders, web redistribution rights, a Mixamo-compatible skeleton, ARKit facial morphs and Oculus visemes. [TalkingHead](https://github.com/met4citizen/TalkingHead) supplies browser gaze, blink, idle and facial-animation infrastructure. Its stock avatars are not a general commercial replacement for KIRA; check each asset license.

Use timestamped speech visemes, such as [Azure Speech viseme events](https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/how-to-speech-synthesis-viseme), for proper synchronization. [Azure's language matrix](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support) lists Hungarian, German and English support, subject to the selected voice. A device TTS `onboundary` event is not an accurate viseme solution.

This alternative requires a custom licensed model, renderer integration, speech credentials and performance/device validation. It is not implemented in the current repository.
