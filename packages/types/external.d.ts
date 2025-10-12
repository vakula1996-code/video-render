declare module "seedrandom" {
  interface SeedRandomOptions {
    state?: boolean;
    entropy?: boolean;
  }

  interface PRNG {
    (): number;
    double(): number;
    int32(): number;
    quick(): number;
    state(): unknown;
  }

  interface SeedRandom {
    (seed?: string, options?: SeedRandomOptions): PRNG;
  }

  const seedrandom: SeedRandom & { prng: PRNG };
  namespace seedrandom {
    type prng = PRNG;
  }

  export default seedrandom;
}

declare module "fs-extra" {
  export function mkdirp(path: string): Promise<void>;
  export function pathExists(path: string): Promise<boolean>;
}

declare module "pixelmatch" {
  import { Buffer } from "buffer";

  interface PixelmatchOptions {
    threshold?: number;
    includeAA?: boolean;
  }

  function pixelmatch(
    img1: Buffer,
    img2: Buffer,
    output: Buffer,
    width: number,
    height: number,
    options?: PixelmatchOptions
  ): number;

  export = pixelmatch;
}

declare module "pngjs" {
  import { Duplex } from "stream";
  import { Buffer } from "buffer";

  interface PNG extends Duplex {
    width: number;
    height: number;
    data: Buffer;
    pack(): NodeJS.ReadableStream;
    on(event: "parsed", callback: (this: PNG) => void): this;
    on(event: "error", callback: (error: Error) => void): this;
  }

  interface PNGConstructor {
    new (options?: { width?: number; height?: number; fill?: boolean }): PNG;
    prototype: PNG;
  }

  const pngjs: {
    PNG: PNGConstructor;
  };

  export { PNG, PNGConstructor };
  export = pngjs;
}

declare module "fluent-ffmpeg" {
  interface FfmpegCommand {
    setFfmpegPath(path: string): FfmpegCommand;
    input(input: string): FfmpegCommand;
    inputOptions(options: string[]): FfmpegCommand;
    videoCodec(codec: string): FfmpegCommand;
    outputOptions(options: string[]): FfmpegCommand;
    output(file: string): FfmpegCommand;
    on(event: "end", handler: () => void): FfmpegCommand;
    on(event: "error", handler: (error: Error) => void): FfmpegCommand;
    run(): void;
  }

  function ffmpeg(input?: string): FfmpegCommand;
  namespace ffmpeg {}

  export = ffmpeg;
}

declare module "ffmpeg-static" {
  const path: string | null;
  export default path;
}

declare module "matter-js" {
  interface Vector {
    x: number;
    y: number;
  }

  interface EngineOptions {
    gravity?: Partial<Vector> & { scale?: number };
  }

  interface Engine {
    world: World;
  }

  interface World {
    gravity: Vector & { scale: number };
    bodies: Body[];
  }

  interface Body {
    position: Vector;
    velocity: Vector;
    angle: number;
    angularVelocity: number;
  }

  interface BodyFactory {
    circle(x: number, y: number, radius: number, options?: Record<string, unknown>): Body;
  }

  interface WorldStatics {
    add(world: World, body: Body | Body[]): void;
    clear(world: World, keepStatic?: boolean): void;
  }

  interface Runner {
    enabled: boolean;
  }

  interface RunnerStatics {
    create(options?: Record<string, unknown>): Runner;
    tick(runner: Runner, engine: Engine, delta: number): void;
  }

  const Bodies: BodyFactory;
  const World: WorldStatics;
  const Runner: RunnerStatics;

  interface EngineStatics {
    create(options?: EngineOptions): Engine;
  }

  const Engine: EngineStatics;

  export { Bodies, Body, Engine, EngineOptions, Runner, World };
}
