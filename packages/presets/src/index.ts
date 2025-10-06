import { Container, Graphics } from "pixi.js";
import type { EngineUpdateEvent, VisEngine, VisScene, SceneUpdateUtils } from "@vis/core";
import type { PixiRenderer } from "@vis/renderer-pixi";
import type { TimelinePlugin } from "@vis/timeline";

export interface PresetContext {
  engine: VisEngine;
  renderer: PixiRenderer;
  timeline?: TimelinePlugin;
}

abstract class PixiPresetScene implements VisScene {
  protected context!: PresetContext;

  constructor(protected readonly presetContext: PresetContext) {
    this.context = presetContext;
  }

  async setup(): Promise<void> {
    this.bootstrap(this.context.renderer.stage);
  }

  abstract bootstrap(stage: Container): void;
  abstract update(event: EngineUpdateEvent, utils: SceneUpdateUtils): void;

  seed(): void {
    // Subclasses can override for deterministic randomness injection.
  }
}

/**
 * CollisionLoop: simple Matter-inspired bouncing orbs with deterministic colors.
 */
export class CollisionLoop extends PixiPresetScene {
  private orbs: Graphics[] = [];

  bootstrap(stage: Container): void {
    stage.removeChildren();
    this.orbs = Array.from({ length: 5 }, (_, index) => {
      const g = new Graphics();
      g.circle(0, 0, 80);
      g.fill({ color: 0xff00ff >> index });
      stage.addChild(g);
      return g;
    });
  }

  update(event: EngineUpdateEvent, utils: SceneUpdateUtils): void {
    const { renderer } = this.context;
    const width = renderer.app.renderer.width;
    const height = renderer.app.renderer.height;
    this.orbs.forEach((orb, index) => {
      const speed = 0.0002 + index * 0.0001;
      const phase = index * Math.PI * 0.5;
      const x = (Math.sin(event.time * speed + phase) * 0.4 + 0.5) * width;
      const y = (Math.cos(event.time * speed + phase) * 0.4 + 0.5) * height;
      orb.position.set(x, y);
    });
  }
}

/**
 * BreathingField: grid of points scaling in and out based on noise + audio peaks.
 */
export class BreathingField extends PixiPresetScene {
  private dots: Graphics[] = [];

  bootstrap(stage: Container): void {
    stage.removeChildren();
    const grid = 8;
    const spacing = this.context.renderer.app.renderer.width / (grid + 1);
    for (let x = 1; x <= grid; x++) {
      for (let y = 1; y <= grid; y++) {
        const dot = new Graphics();
        dot.circle(0, 0, 12);
        dot.fill({ color: 0x00ffff, alpha: 0.4 });
        dot.position.set(spacing * x, spacing * y);
        stage.addChild(dot);
        this.dots.push(dot);
      }
    }
  }

  update(event: EngineUpdateEvent, utils: SceneUpdateUtils): void {
    this.dots.forEach((dot, index) => {
      const n = utils.noise(index * 0.1, event.time * 0.0005);
      const scale = 0.8 + n * 0.4;
      dot.scale.set(scale);
    });
  }
}

/**
 * SymmetryBreaker: kaleidoscopic arcs rotating based on timeline progress.
 */
export class SymmetryBreaker extends PixiPresetScene {
  private petals: Graphics[] = [];

  bootstrap(stage: Container): void {
    stage.removeChildren();
    for (let i = 0; i < 6; i++) {
      const petal = new Graphics();
      petal.moveTo(0, 0);
      petal.arc(0, 0, 400, 0, Math.PI / 4);
      petal.fill({ color: 0xffffff, alpha: 0.1 });
      stage.addChild(petal);
      this.petals.push(petal);
    }
  }

  update(event: EngineUpdateEvent): void {
    this.petals.forEach((petal, index) => {
      petal.rotation = (event.time / 1000) * 0.3 + index * (Math.PI / 3);
      const scale = 0.6 + 0.2 * Math.sin(event.time * 0.0005 + index);
      petal.scale.set(scale);
    });
  }
}

export function createPresetScene(name: "CollisionLoop" | "BreathingField" | "SymmetryBreaker", context: PresetContext): VisScene {
  const registry = {
    CollisionLoop,
    BreathingField,
    SymmetryBreaker,
  } as const;
  const SceneCtor = registry[name];
  return new SceneCtor(context);
}
