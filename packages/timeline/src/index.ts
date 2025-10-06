import { gsap } from "gsap";
import type { EngineUpdateEvent, VisEngine, VisPlugin } from "@vis/core";

export interface TimelineBinding {
  label: string;
  duration: number;
  onUpdate: (progress: number, event: EngineUpdateEvent) => void;
}

/**
 * The timeline plugin maps GSAP's timing model into the deterministic frame clock from @vis/core.
 * It listens to beat/bar events from @vis/audio and emits progress callbacks.
 */
export class TimelinePlugin implements VisPlugin {
  readonly name = "@vis/timeline";
  private readonly bindings: TimelineBinding[] = [];
  private engine?: VisEngine;

  async setup(engine: VisEngine): Promise<void> {
    this.engine = engine;
    engine.on("audio:beat", () => this.syncToTransport());
  }

  update(event: EngineUpdateEvent): void {
    for (const binding of this.bindings) {
      const progress = (event.time % binding.duration) / binding.duration;
      binding.onUpdate(progress, event);
    }
  }

  createBinding(binding: TimelineBinding): void {
    this.bindings.push(binding);
  }

  private syncToTransport(): void {
    gsap.ticker.tick();
  }
}

export function createTimelinePlugin(): TimelinePlugin {
  return new TimelinePlugin();
}
