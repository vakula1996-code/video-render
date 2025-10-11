import "pixi.js";
import "./style.css";
import { VisEngine, LoopController } from "@vis/core";
import { PixiRenderer } from "@vis/renderer-pixi";
import { AudioController } from "@vis/audio";
import { createTimelinePlugin } from "@vis/timeline";
import { createPresetScene } from "@vis/presets";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Не вдалося знайти контейнер для демо (#app)");
}

const canvas = document.createElement("canvas");
canvas.id = "vis-canvas";
root.appendChild(canvas);

const overlay = document.createElement("div");
overlay.className = "vis-overlay";
overlay.innerHTML = `
  <strong>Ініціалізація сцени</strong>
  <span>Чекаємо на запуск петлі <em>CollisionLoop</em>…</span>
`;
root.appendChild(overlay);

const loop = new LoopController({ duration: 8, fps: 60, seed: "demo" });
const engine = new VisEngine(loop);
const renderer = new PixiRenderer({ view: canvas, width: 720, height: 1280, backgroundColor: 0x050505 });
renderer.app.renderer.resolution = Math.min(window.devicePixelRatio, 2);
renderer.app.renderer.resize(renderer.app.renderer.width, renderer.app.renderer.height);
const audio = new AudioController({ bpm: 120, beatsPerBar: 4 });
const timeline = createTimelinePlugin();

(async () => {
  await engine.registerPlugin(renderer);
  renderer.debugFrame();
  await engine.registerPlugin(timeline);
  await engine.registerPlugin(audio);
  await audio.connect();

  const scene = createPresetScene("CollisionLoop", { engine, renderer, timeline });
  await engine.loadScene(scene);
  engine.start();
})();

engine.once("engine:ready", () => {
  overlay.classList.add("vis-overlay--ready");
  overlay.innerHTML = `
    <strong>Петля активна</strong>
    <span>Сцена <em>CollisionLoop</em> вже працює.</span>
    <span>Натисніть <kbd>R</kbd>, щоб перезапустити петлю.</span>
  `;
});

// Offline renderer hook expected by puppeteer pipeline.
(window as typeof window & { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame = async (ms: number) => {
  await engine.renderFrame(ms);
};

const restartLoop = () => {
  engine.stop();
  loop.clock.seek(0);
  engine.start();
};

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    restartLoop();
  }
});
