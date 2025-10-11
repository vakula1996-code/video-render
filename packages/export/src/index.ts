import { mkdirp, pathExists } from "fs-extra";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import puppeteer from "puppeteer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

export interface OfflineRendererOptions {
  entry: string;
  outDir: string;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
}

export interface FrameRenderResult {
  frame: number;
  path: string;
}

/**
 * Renders a deterministic PNG sequence by asking the page to render a specific frame.
 * The page must expose `window.__vis_renderFrame(timeMs)` for Puppeteer to call.
 */
export async function renderDeterministicFrames(options: OfflineRendererOptions): Promise<FrameRenderResult[]> {
  const results: FrameRenderResult[] = [];
  await mkdirp(options.outDir);
  const browser = await puppeteer.launch({
    headless: "shell",
    args: [
      "--headless=new",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=opengl",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });

  const url = options.entry.startsWith("http")
    ? options.entry
    : pathToFileURL(resolve(options.entry)).toString();
  await page.goto(url);

  for (let frame = 0; frame < options.totalFrames; frame++) {
    const time = (frame / options.fps) * 1000;
    await page.evaluate((ms) => {
      return (window as unknown as { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame?.(ms);
    }, time);
    const outPath = join(options.outDir, `frame-${frame.toString().padStart(5, "0")}.png`);
    await page.screenshot({ path: outPath });
    results.push({ frame, path: outPath });
  }

  await browser.close();
  return results;
}

export interface ExportVideoOptions {
  inputPattern: string;
  outputFile: string;
  fps: number;
  codec?: "libx264" | "prores_ks";
  pixelFormat?: string;
}

/**
 * Wraps ffmpeg invocation to build perfect mp4/prores loops from PNG sequences.
 */
export async function encodeVideo(options: ExportVideoOptions): Promise<void> {
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static binary not found");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    ffmpeg()
      .setFfmpegPath(ffmpegStatic)
      .input(options.inputPattern)
      .inputOptions(["-framerate", options.fps.toString()])
      .videoCodec(options.codec ?? "libx264")
      .outputOptions([
        "-pix_fmt",
        options.pixelFormat ?? "yuv420p",
        "-y",
      ])
      .output(options.outputFile)
      .on("end", () => resolvePromise())
      .on("error", (error) => rejectPromise(error))
      .run();
  });
}

export async function ensureOutDir(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    await mkdirp(path);
  }
}
