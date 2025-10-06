import { Engine as MatterEngine, World, Bodies, Body, Runner } from "matter-js";
import type { EngineUpdateEvent, VisEngine, VisPlugin } from "@vis/core";

export interface PhysicsOptions {
  gravity?: number;
}

export interface PhysicsBody {
  body: Body;
  update?(event: EngineUpdateEvent): void;
}

/**
 * Lightweight bridge between Matter.js and the VIS engine. Scenes register bodies and respond to simulation updates.
 */
export class PhysicsPlugin implements VisPlugin {
  readonly name = "@vis/physics";
  private readonly matter: MatterEngine;
  private readonly runner: Runner;
  readonly world: World;
  readonly bodies: PhysicsBody[] = [];

  constructor(options: PhysicsOptions = {}) {
    this.matter = MatterEngine.create({
      gravity: { y: options.gravity ?? 0.3 },
    });
    this.runner = Runner.create();
    this.world = this.matter.world;
  }

  async setup(): Promise<void> {
    // Future: expose debug renderer / devtools hooks.
  }

  update(event: EngineUpdateEvent): void {
    Runner.tick(this.runner, this.matter, event.delta);
    for (const body of this.bodies) {
      body.update?.(event);
    }
  }

  addBody(body: PhysicsBody): void {
    this.bodies.push(body);
    World.add(this.world, body.body);
  }

  clear(): void {
    World.clear(this.world, false);
    this.bodies.splice(0, this.bodies.length);
  }
}

export function createCircleBody(x: number, y: number, radius: number): PhysicsBody {
  const body = Bodies.circle(x, y, radius, { restitution: 0.9 });
  return { body };
}
