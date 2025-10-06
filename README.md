# VIS Monorepo

Modular TypeScript toolkit for building deterministic, audio-reactive 2D video loops. The monorepo is organized into packages that can be composed for real-time WebGL2 rendering, offline deterministic export, and future editor tooling.

## Packages

- **@vis/core** — Deterministic engine core with plugin lifecycle, loop controller, and seeded randomness utilities.
- **@vis/renderer-pixi** — PixiJS/WebGL2 renderer with future-ready post-processing hooks (aligned to PixiJS 7.4 filter APIs).
- **@vis/audio** — Tone.js transport plus Meyda FFT analysis for beat and spectrum events.
- **@vis/timeline** — GSAP integration and audio-synchronized timeline bindings.
- **@vis/physics** — Optional Matter.js adapter for rigid-body simulations.
- **@vis/export** — Offline headless rendering pipeline for Puppeteer + ffmpeg exports.
- **@vis/presets** — Sample scenes demonstrating loop patterns and deterministic control.
- **@vis/editor** — Reserved workspace for upcoming visual editor (not yet implemented).

## Scripts

```bash
npm run dev      # Launch the PixiJS realtime preview via Vite
npm run render   # Run Puppeteer deterministic renderer
npm run export   # Convert PNG sequences to mp4 via ffmpeg
npm run analyze  # Offline Meyda FFT analysis helper
```

## Development

- Build packages with `npm run build --workspaces`.
- Packages use `tsup` for dual CJS/ESM output and TypeScript declarations.
- Offline rendering expects `window.__vis_renderFrame(timeMs)` to be defined by the loaded page.
- Packages are version-locked to the latest compatible PixiJS 7.4, Tone.js 14.8, Meyda 5.6, and Puppeteer 22 releases to prevent transitive conflicts between realtime and offline renderers.
- Puppeteer is configured with GPU flags for headless WebGL2 support.

Add new plugins by implementing the `VisPlugin` interface in `@vis/core` and registering it on the `VisEngine` instance.
