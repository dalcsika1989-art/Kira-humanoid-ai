# Assets and dependencies

- The user supplied the visual reference image. It was used to generate a clean, standalone KIRA portrait for the interface. The portrait is a raster asset and has no animation rig. No external actor, stock 3D avatar or commercial model is bundled.
- Lucide icons: [Lucide](https://lucide.dev), ISC license.
- React and React DOM: [React](https://react.dev), MIT license.
- Vite, TypeScript and esbuild: see their installed package licenses.
- LiveKit client: [livekit/client-sdk-js](https://github.com/livekit/client-sdk-js), Apache-2.0 license.
- Capacitor: [ionic-team/capacitor](https://github.com/ionic-team/capacitor), MIT license.
- Gemini and LiveAvatar are external services governed by their respective service terms, access controls, quotas and billing. A provider integration does not grant rights to a custom avatar or establish that a provider supports a specific commercial use.

Before distributing KIRA, choose a source-code license, confirm rights to use the supplied reference and generated portrait, and retain required dependency notices. `npm install` generates the dependency lockfile; audit the actual locked versions and their notices before release.
