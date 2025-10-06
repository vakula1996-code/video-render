import "pixi.js";
import { VisEngine, LoopController } from "@vis/core";
import { PixiRenderer } from "@vis/renderer-pixi";
import { AudioController } from "@vis/audio";
import { createTimelinePlugin } from "@vis/timeline";
import { createPresetScene } from "@vis/presets";

const canvas = document.createElement("canvas");
canvas.id = "vis-canvas";
document.getElementById("app")?.appendChild(canvas);

const loop = new LoopController({ duration: 8, fps: 60, seed: "demo" });
const engine = new VisEngine(loop);
const renderer = new PixiRenderer({ view: canvas, width: 720, height: 1280, backgroundColor: 0x050505 });
const audio = new AudioController({ bpm: 120, beatsPerBar: 4 });
const timeline = createTimelinePlugin();

(async () => {
  await engine.registerPlugin(renderer);
  await engine.registerPlugin(timeline);
  await engine.registerPlugin(audio);
  await audio.connect();

  const scene = createPresetScene("CollisionLoop", { engine, renderer, timeline });
  await engine.loadScene(scene);
  engine.start();
})();

// Offline renderer hook expected by puppeteer pipeline.
(window as typeof window & { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame = async (ms: number) => {
  await engine.renderFrame(ms);
};
