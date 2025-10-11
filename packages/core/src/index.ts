import EventEmitter from "eventemitter3";
import seedrandom from "seedrandom";
import SimplexNoise from "simplex-noise";

/**
 * Core types used across the visualization engine. Scenes, plugins, renderers and audio emitters
 * communicate through the {@link VisEngine} event bus to remain modular.
 */
export type VisEventMap = {
  "engine:ready": void;
  "engine:update": EngineUpdateEvent;
  "engine:seek": { time: number };
  "audio:beat": AudioBeatEvent;
  "audio:bar": AudioBeatEvent;
  "audio:fft": AudioFFTEvent;
};

export interface EngineUpdateEvent {
  time: number;
  delta: number;
  frame: number;
}

export interface AudioBeatEvent {
  time: number;
  index: number;
}

export interface AudioFFTEvent {
  time: number;
  fft: Float32Array;
  peak?: "bass" | "mid" | "high";
}

export interface VisPlugin {
  name: string;
  setup(engine: VisEngine): Promise<void> | void;
  update?(event: EngineUpdateEvent): void;
  dispose?(): void;
}

export interface VisScene {
  /**
   * Called once after all plugins are ready.
   */
  setup(engine: VisEngine): Promise<void> | void;
  /**
   * Per-frame animation hook. Deterministic and side-effect free.
   */
  update(event: EngineUpdateEvent, utils: SceneUpdateUtils): void;
  /**
   * Used by offline rendering to ensure the exact same state for a given frame.
   */
  seed?(rng: SeededRandom): void;
}

export interface SceneUpdateUtils {
  noise: (x: number, y?: number, z?: number) => number;
  random: () => number;
}

export interface LoopControllerOptions {
  duration: number; // duration in seconds
  fps?: number;
  seed?: string;
}

export class DeterministicClock {
  readonly fps: number;
  private _frame = 0;
  private _time = 0;

  constructor(fps = 60) {
    this.fps = fps;
  }

  tick(deltaFrames = 1): EngineUpdateEvent {
    this._frame += deltaFrames;
    const delta = (deltaFrames / this.fps) * 1000;
    this._time += delta;
    return {
      frame: this._frame,
      time: this._time,
      delta,
    };
  }

  seek(frame: number): EngineUpdateEvent {
    this._frame = frame;
    this._time = (frame / this.fps) * 1000;
    return {
      frame: this._frame,
      time: this._time,
      delta: 0,
    };
  }
}

export class SeededRandom {
  private readonly rng: seedrandom.prng;
  private readonly simplex: SimplexNoise;

  constructor(seed: string) {
    this.rng = seedrandom(seed, { state: true });
    this.simplex = new SimplexNoise(this.rng);
  }

  next(): number {
    return this.rng.quick();
  }

  /**
   * 2D/3D simplex noise helper. Values are deterministic for a given seed.
   */
  noise2D(x: number, y: number): number {
    return this.simplex.noise2D(x, y);
  }

  noise3D(x: number, y: number, z: number): number {
    return this.simplex.noise3D(x, y, z);
  }
}

export class LoopController {
  readonly options: Required<LoopControllerOptions>;
  readonly seed: SeededRandom;
  readonly clock: DeterministicClock;

  constructor(options: LoopControllerOptions) {
    this.options = {
      fps: options.fps ?? 60,
      seed: options.seed ?? "vis-loop",
      duration: options.duration,
    };
    this.clock = new DeterministicClock(this.options.fps);
    this.seed = new SeededRandom(this.options.seed);
  }

  get totalFrames(): number {
    return Math.round(this.options.duration * this.options.fps);
  }

  getFrameTime(frame: number): number {
    return (frame / this.options.fps) * 1000;
  }
}

export interface RendererPlugin extends VisPlugin {
  renderFrame(time: number): Promise<void> | void;
}

export interface AudioPlugin extends VisPlugin {
  connect(): Promise<void> | void;
}

export class VisEngine extends EventEmitter<VisEventMap> {
  private readonly plugins: VisPlugin[] = [];
  private scene?: VisScene;
  private loop: LoopController;
  private rafHandle: number | null = null;
  private running = false;
  private readonly utilsSeed: SeededRandom;

  constructor(loop = new LoopController({ duration: 8 })) {
    super();
    this.loop = loop;
    this.utilsSeed = new SeededRandom(loop.options.seed);
  }

  async registerPlugin(plugin: VisPlugin): Promise<void> {
    this.plugins.push(plugin);
    await plugin.setup(this);
  }

  async loadScene(scene: VisScene): Promise<void> {
    this.scene = scene;
    scene.seed?.(this.loop.seed);
    await scene.setup(this);
  }

  setLoop(loop: LoopController): void {
    this.loop = loop;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit("engine:ready", undefined);
    const tick = () => {
      if (!this.running) return;
      const update = this.loop.clock.tick();
      this.emit("engine:update", update);
      this.scene?.update(update, this.buildSceneUtils(update));
      for (const plugin of this.plugins) {
        plugin.update?.(update);
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  async renderFrame(time: number): Promise<void> {
    const frame = Math.round((time / 1000) * this.loop.options.fps);
    const update = this.loop.clock.seek(frame);
    this.emit("engine:seek", { time });
    this.emit("engine:update", update);
    this.scene?.update(update, this.buildSceneUtils(update));
    for (const plugin of this.plugins) {
      plugin.update?.(update);
      if ("renderFrame" in plugin && typeof (plugin as RendererPlugin).renderFrame === "function") {
        await (plugin as RendererPlugin).renderFrame(time);
      }
    }
  }

  private buildSceneUtils(update: EngineUpdateEvent): SceneUpdateUtils {
    const noisePhase = update.time / 1000;
    return {
      noise: (x: number, y = 0, z = noisePhase) => this.loop.seed.noise3D(x, y, z),
      random: () => this.loop.seed.next(),
    };
  }
}

export * from "./lifecycle";
