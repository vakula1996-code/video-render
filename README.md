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
npm run dev       # Launch the PixiJS realtime preview via Vite
npm run render    # Run Puppeteer deterministic renderer
npm run export    # Convert PNG sequences to mp4 via ffmpeg
npm run analyze   # Offline Meyda FFT analysis helper
npm run compare   # Compare rendered frames against a baseline with diff outputs
npm run pipeline  # Render frames, encode video and emit a release manifest
```

## Development

- Build packages with `npm run build --workspaces`.
- Packages use `tsup` for dual CJS/ESM output and TypeScript declarations.
- Offline rendering expects `window.__vis_renderFrame(timeMs)` to be defined by the loaded page.
- Packages are version-locked to the latest compatible PixiJS 7.4, Tone.js 14.8, Meyda 5.6, and Puppeteer 22 releases to prevent transitive conflicts between realtime and offline renderers.
- Puppeteer is configured with GPU flags for headless WebGL2 support.

Add new plugins by implementing the `VisPlugin` interface in `@vis/core` and registering it on the `VisEngine` instance.

## Step-by-step workflow (що робити далі)

1. **Install dependencies** – run `npm install` once to fetch workspace packages.
2. **Build core packages** – execute `npm run build --workspaces` so shared libraries compile before running apps.
3. **Launch realtime preview** – start the Vite-powered PixiJS preview with `npm run dev` and open the provided URL in the browser to iterate on visuals.
4. **Iterate on plugins and presets** – edit files in `packages/` or `apps/` while the dev server hot-reloads changes.
5. **Run deterministic renders** – when satisfied with a loop, call `npm run render` to generate a frame sequence using the headless renderer.
6. **Export to video** – finish by converting the frame sequence into an `.mp4` using `npm run export`.
7. **Analyze audio (optional)** – use `npm run analyze` to precompute FFT data for audio-reactive scenes.

Following these steps ensures a repeatable pipeline from development through deterministic export.

## Далі за планом

8. **Контролюйте версію** – фіксуйте стабільні зміни в Git, створюйте тематичні гілки та синхронізуйте їх із CI перед запуском рендерингу на сервері.
9. **Перевіряйте узгодженість кадрів** – використовуйте `npm run compare`, щоб автоматично звірити нові PNG із базовою послідовністю та за потреби отримати diff-кадри.
10. **Оновлюйте аудіо-аналітику** – при змінах саундтреку повторно запускайте `npm run analyze`, кешуйте результат у репозиторії або CDN і підключайте через `@vis/audio`.
11. **Оптимізуйте продуктивність** – профілюйте сцени через DevTools Performance/Memory, відключайте непотрібні плагіни та стежте за кількістю draw calls у PixiJS Inspector.
12. **Автоматизуйте експорт** – скрипт `npm run pipeline` послідовно побудує кадри, збере `.mp4` та збереже `manifest.json` з метаданими loop-у.
13. **Готуйте реліз** – додавайте артефакти з manifest-файлом, seed-ом, контрольними сумами та відео у каталозі preset-ів або реліз-нотах.

Дотримання цих кроків допоможе довести цикл розробки від швидких ітерацій до надійних релізів без втрати детермінізму.
