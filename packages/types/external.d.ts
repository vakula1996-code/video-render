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
