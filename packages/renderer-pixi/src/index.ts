import { Application, Container, Graphics } from "pixi.js";
import { BlurFilter } from "@pixi/filter-blur";
import { ColorMatrixFilter } from "@pixi/filter-color-matrix";
import type { EngineUpdateEvent, RendererPlugin, VisEngine } from "@vis/core";

export interface PixiRendererOptions {
  width?: number;
  height?: number;
  backgroundColor?: number;
  view?: HTMLCanvasElement;
  postEffects?: (() => ColorMatrixFilter | BlurFilter)[];
}

/**
 * The PixiRenderer is responsible for real-time WebGL2 rendering and deterministic offline frames.
 * Future extensions include custom filter graphs, framebuffer capture hooks and dynamic layer composition.
 */
export class PixiRenderer implements RendererPlugin {
  readonly name = "@vis/renderer-pixi";
  readonly app: Application;
  readonly stage: Container;
  private postFxChain: (ColorMatrixFilter | BlurFilter)[] = [];

  constructor(private readonly options: PixiRendererOptions = {}) {
    this.app = new Application({
      antialias: true,
      autoStart: false,
      backgroundColor: this.options.backgroundColor ?? 0x000000,
      preserveDrawingBuffer: true,
      view: this.options.view,
      width: this.options.width ?? 1080,
      height: this.options.height ?? 1920,
    });
    this.stage = this.app.stage;
  }

  async setup(): Promise<void> {
    this.postFxChain = this.options.postEffects?.map((factory) => factory()) ?? [];
    if (this.postFxChain.length > 0) {
      this.stage.filters = this.postFxChain;
    }
  }

  update(event: EngineUpdateEvent): void {
    this.app.render();
  }

  async renderFrame(): Promise<void> {
    this.app.render();
  }

  /**
   * Utility helper for demos: spawn a subtle border to make loops feel more physical.
   */
  debugFrame(): void {
    const frame = new Graphics();
    frame.lineStyle({ width: 4, color: 0xffffff, alpha: 0.08 });
    frame.drawRect(0, 0, this.app.renderer.width, this.app.renderer.height);
    this.stage.addChild(frame);
  }
}

export type PixiSceneBootstrap = (options: {
  stage: Container;
  renderer: PixiRenderer;
  engine: VisEngine;
}) => void;

export function createPixiPlugin(options?: PixiRendererOptions): PixiRenderer {
  return new PixiRenderer(options);
}
