import "pixi.js";
import "./style.css";
import { VisEngine, LoopController } from "@vis/core";
import { PixiRenderer } from "@vis/renderer-pixi";
import { AudioController } from "@vis/audio";
import { createTimelinePlugin } from "@vis/timeline";
import { createPresetScene } from "@vis/presets";

type RenderBridge = typeof window & {
  __vis_renderFrame?: (ms: number) => Promise<void>;
  __vis_ready?: boolean;
};

const renderBridge = window as RenderBridge;
renderBridge.__vis_ready = false;

const root = document.getElementById("app");

if (!root) {
  throw new Error("Не вдалося знайти контейнер для демо (#app)");
}

const canvas = document.createElement("canvas");
canvas.id = "vis-canvas";
root.appendChild(canvas);

const overlay = document.createElement("div");
overlay.className = "vis-overlay";

const overlayTitle = document.createElement("strong");
overlayTitle.textContent = "Ініціалізація сцени";

const overlayStatus = document.createElement("span");
overlayStatus.innerHTML = "Чекаємо на запуск петлі <em>CollisionLoop</em>…";

const overlayAudio = document.createElement("span");
overlayAudio.className = "vis-overlay__audio";

const overlayHint = document.createElement("span");
overlayHint.className = "vis-overlay__hint";
overlayHint.innerHTML = "Натисніть <kbd>R</kbd>, щоб перезапустити петлю.";
overlayHint.hidden = true;

overlay.append(overlayTitle, overlayStatus, overlayAudio, overlayHint);
root.appendChild(overlay);

const loop = new LoopController({ duration: 8, fps: 60, seed: "demo" });
const engine = new VisEngine(loop);
const renderer = new PixiRenderer({ view: canvas, width: 720, height: 1280, backgroundColor: 0x050505 });
renderer.app.renderer.resolution = Math.min(window.devicePixelRatio, 2);
renderer.app.renderer.resize(renderer.app.renderer.width, renderer.app.renderer.height);
const audio = new AudioController({ bpm: 120, beatsPerBar: 4 });
const timeline = createTimelinePlugin();

type AudioOverlayState = "hidden" | "pending" | "blocked" | "ready" | "error";

const audioMessages: Record<Exclude<AudioOverlayState, "hidden">, string> = {
  pending: "Готуємо аудіо…",
  blocked: "Натисніть будь-де у вікні, щоб увімкнути аудіо.",
  ready: "Аудіо активне.",
  error: "Не вдалося активувати аудіо. Спробуйте повторити взаємодію.",
};

const setAudioState = (state: AudioOverlayState, message?: string) => {
  overlay.classList.remove("vis-overlay--audio-blocked", "vis-overlay--audio-ready", "vis-overlay--audio-error");
  if (state === "hidden") {
    overlayAudio.hidden = true;
    return;
  }

  overlayAudio.hidden = false;
  overlayAudio.textContent = message ?? audioMessages[state];

  if (state === "blocked") {
    overlay.classList.add("vis-overlay--audio-blocked");
  } else if (state === "ready") {
    overlay.classList.add("vis-overlay--audio-ready");
  } else if (state === "error") {
    overlay.classList.add("vis-overlay--audio-error");
  }
};

const markAudioReady = () => {
  setAudioState("ready");
  detachAudioUnlockListeners();
};

const audioUnlockEvents: Array<keyof WindowEventMap> = ["pointerdown", "keydown"];
let audioUnlockArmed = false;

const detachAudioUnlockListeners = () => {
  if (!audioUnlockArmed) {
    return;
  }
  audioUnlockArmed = false;
  audioUnlockEvents.forEach((event) => window.removeEventListener(event, handleAudioUnlock));
};

const attachAudioUnlockListeners = () => {
  if (audioUnlockArmed || audio.isConnected) {
    return;
  }
  audioUnlockArmed = true;
  audioUnlockEvents.forEach((event) => window.addEventListener(event, handleAudioUnlock));
};

async function handleAudioUnlock(): Promise<void> {
  detachAudioUnlockListeners();
  setAudioState("pending", "Активуємо аудіо…");
  try {
    await audio.connect();
    markAudioReady();
  } catch (error) {
    console.warn("Не вдалося активувати аудіо після взаємодії користувача", error);
    setAudioState("error", "Не вдалося активувати аудіо. Спробуйте натиснути ще раз.");
    window.setTimeout(() => {
      if (!audio.isConnected) {
        requestAudioUnlock();
      }
    }, 600);
  }
}

const requestAudioUnlock = () => {
  if (audio.isConnected) {
    return;
  }
  setAudioState("blocked");
  attachAudioUnlockListeners();
};

setAudioState("pending");

(async () => {
  await engine.registerPlugin(renderer);
  renderer.debugFrame();
  await engine.registerPlugin(timeline);
  await engine.registerPlugin(audio);

  const scene = createPresetScene("CollisionLoop", { engine, renderer, timeline });
  await engine.loadScene(scene);
  engine.start();

  audio
    .connect()
    .then(() => {
      markAudioReady();
    })
    .catch((error) => {
      console.warn("Автозапуск аудіо заблоковано браузером", error);
      requestAudioUnlock();
    });

  window.setTimeout(() => {
    if (!audio.isConnected) {
      requestAudioUnlock();
    }
  }, 1200);
})();

engine.once("engine:ready", () => {
  overlay.classList.add("vis-overlay--ready");
  overlayTitle.textContent = "Петля активна";
  overlayStatus.innerHTML = "Сцена <em>CollisionLoop</em> вже працює.";
  overlayHint.hidden = false;
  if (audio.isConnected) {
    setAudioState("ready");
  }
  renderBridge.__vis_ready = true;
});

// Offline renderer hook expected by puppeteer pipeline.
(renderBridge).__vis_renderFrame = async (ms: number) => {
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
