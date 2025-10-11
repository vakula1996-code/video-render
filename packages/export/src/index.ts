import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdirp, pathExists } from "fs-extra";
import { readdir, stat, writeFile, mkdir } from "fs/promises";
import { join, resolve, relative, dirname } from "path";
import { pathToFileURL } from "url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import puppeteer from "puppeteer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import type { PNG } from "pngjs";

type PngModule = typeof import("pngjs");
type PixelmatchFn = typeof import("pixelmatch");

let pngModulePromise: Promise<PngModule> | null = null;
function loadPngModule(): Promise<PngModule> {
  if (!pngModulePromise) {
    pngModulePromise = import("pngjs");
  }
  return pngModulePromise;
}

let pixelmatchPromise: Promise<PixelmatchFn> | null = null;
async function loadPixelmatch(): Promise<PixelmatchFn> {
  if (!pixelmatchPromise) {
    pixelmatchPromise = import("pixelmatch").then((module) => {
      const asUnknown = module as unknown;
      if (typeof asUnknown === "function") {
        return asUnknown as PixelmatchFn;
      }
      const withDefault = asUnknown as { default?: PixelmatchFn };
      return (withDefault.default ?? withDefault) as PixelmatchFn;
    });
  }
  return pixelmatchPromise;
}

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

export interface RenderAndEncodeOptions extends OfflineRendererOptions {
  videoFile?: string;
  codec?: "libx264" | "prores_ks";
  pixelFormat?: string;
  framePattern?: string;
}

export interface RenderAndEncodeResult {
  frames: FrameRenderResult[];
  videoFile: string;
  framePattern: string;
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
    protocolTimeout: 120_000,
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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);

    const url = options.entry.startsWith("http")
      ? options.entry
      : pathToFileURL(resolve(options.entry)).toString();
    await page.goto(url, { waitUntil: "networkidle0" });

    for (let frame = 0; frame < options.totalFrames; frame++) {
      const time = (frame / options.fps) * 1000;
      await page.evaluate((ms) => {
        return (window as unknown as { __vis_renderFrame?: (ms: number) => Promise<void> }).__vis_renderFrame?.(ms);
      }, time);
      const outPath = join(options.outDir, `frame-${frame.toString().padStart(5, "0")}.png`);
      await page.screenshot({ path: outPath });
      results.push({ frame, path: outPath });
    }
  } finally {
    await browser.close();
  }
  return results;
}

export async function runRenderAndEncode(options: RenderAndEncodeOptions): Promise<RenderAndEncodeResult> {
  await ensureOutDir(options.outDir);
  const frames = await renderDeterministicFrames(options);
  const framePattern =
    options.framePattern ?? inferFramePattern(frames, options.outDir) ?? join(options.outDir, "frame-%05d.png");
  const videoFile = options.videoFile ?? join(options.outDir, "output.mp4");
  await encodeVideo({
    inputPattern: framePattern,
    outputFile: videoFile,
    fps: options.fps,
    codec: options.codec,
    pixelFormat: options.pixelFormat,
  });
  return { frames, videoFile, framePattern };
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
  const binaryPath = ffmpegStatic;
  if (binaryPath == null) {
    throw new Error("ffmpeg-static binary not found");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    ffmpeg()
      .setFfmpegPath(binaryPath)
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
      .on("error", (error: Error) => rejectPromise(error))
      .run();
  });
}

export async function ensureOutDir(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    await mkdirp(path);
  }
}

export interface CompareFrameSequencesOptions {
  actualDir: string;
  baselineDir: string;
  diffDir?: string;
  threshold?: number;
}

export interface FrameMismatch {
  frame: string;
  diffPixels: number;
  totalPixels: number;
  mismatchRatio: number;
  diffPath?: string;
}

export interface RegressionSummary {
  diffs: FrameMismatch[];
  totalCompared: number;
  maxMismatch: number;
  averageMismatch: number;
  missingInActual: string[];
  missingInBaseline: string[];
}

export async function compareFrameSequences(options: CompareFrameSequencesOptions): Promise<RegressionSummary> {
  const [{ PNG }, pixelmatchFn] = await Promise.all([loadPngModule(), loadPixelmatch()]);
  const [actualFiles, baselineFiles] = await Promise.all([
    collectPngs(options.actualDir),
    collectPngs(options.baselineDir),
  ]);

  const actualSet = new Set(actualFiles);
  const baselineSet = new Set(baselineFiles);
  const intersection = baselineFiles.filter((file) => actualSet.has(file));
  const missingInActual = baselineFiles.filter((file) => !actualSet.has(file));
  const missingInBaseline = actualFiles.filter((file) => !baselineSet.has(file));

  const diffs: FrameMismatch[] = [];
  if (options.diffDir) {
    await mkdir(options.diffDir, { recursive: true });
  }

  for (const file of intersection) {
    const baselinePath = join(options.baselineDir, file);
    const actualPath = join(options.actualDir, file);
    const [baselinePng, actualPng] = await Promise.all([readPng(baselinePath, PNG), readPng(actualPath, PNG)]);
    if (baselinePng.width !== actualPng.width || baselinePng.height !== actualPng.height) {
      throw new Error(`Frame size mismatch for ${file}`);
    }
    const diffPng = new PNG({ width: baselinePng.width, height: baselinePng.height });
    const diffPixels = pixelmatchFn(
      actualPng.data,
      baselinePng.data,
      diffPng.data,
      baselinePng.width,
      baselinePng.height,
      {
        threshold: options.threshold ?? 0.1,
        includeAA: false,
      }
    );
    let diffPath: string | undefined;
    if (options.diffDir && diffPixels > 0) {
      diffPath = join(options.diffDir, file);
      await writePng(diffPng, diffPath);
    }
    const totalPixels = baselinePng.width * baselinePng.height;
    diffs.push({
      frame: file,
      diffPixels,
      totalPixels,
      mismatchRatio: diffPixels / totalPixels,
      diffPath,
    });
  }

  const totalCompared = diffs.length;
  const maxMismatch = totalCompared === 0 ? 0 : Math.max(...diffs.map((d) => d.mismatchRatio));
  const averageMismatch =
    totalCompared === 0 ? 0 : diffs.reduce((sum, diff) => sum + diff.mismatchRatio, 0) / totalCompared;

  return { diffs, totalCompared, maxMismatch, averageMismatch, missingInActual, missingInBaseline };
}

export interface ReleaseManifestOptions {
  frames: FrameRenderResult[];
  videoFile: string;
  fps: number;
  durationMs: number;
  seed: string;
  outputPath: string;
  plugins?: string[];
  extra?: Record<string, unknown>;
}

export interface ReleaseManifest {
  version: string;
  generatedAt: string;
  fps: number;
  durationMs: number;
  totalFrames: number;
  seed: string;
  video: {
    path: string;
    hash: string;
    size: number;
  };
  frames: {
    frame: number;
    path: string;
    hash: string;
    size: number;
  }[];
  plugins?: string[];
  extra?: Record<string, unknown>;
}

export async function writeReleaseManifest(options: ReleaseManifestOptions): Promise<ReleaseManifest> {
  await ensureOutDir(dirname(options.outputPath));
  const manifestDir = dirname(options.outputPath);
  const frameEntries = [] as ReleaseManifest["frames"];
  for (const frame of options.frames) {
    const [hash, info] = await Promise.all([computeFileHash(frame.path), stat(frame.path)]);
    frameEntries.push({
      frame: frame.frame,
      path: relative(manifestDir, frame.path),
      hash,
      size: info.size,
    });
  }
  const videoInfo = await stat(options.videoFile);
  const videoHash = await computeFileHash(options.videoFile);
  const manifest: ReleaseManifest = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    fps: options.fps,
    durationMs: options.durationMs,
    totalFrames: options.frames.length,
    seed: options.seed,
    video: {
      path: relative(manifestDir, options.videoFile),
      hash: videoHash,
      size: videoInfo.size,
    },
    frames: frameEntries,
    plugins: options.plugins,
    extra: options.extra,
  };
  await writeFile(options.outputPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

async function collectPngs(dir: string): Promise<string[]> {
  const files = await readdir(dir);
  return files
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .sort();
}

async function readPng(path: string, PngCtor: PngModule["PNG"]): Promise<PNG> {
  return await new Promise<PNG>((resolve, reject) => {
    createReadStream(path)
      .pipe(new PngCtor())
      .on("parsed", function (this: PNG) {
        resolve(this);
      })
      .on("error", reject);
  });
}

async function writePng(png: PNG, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    png
      .pack()
      .pipe(createWriteStream(path))
      .on("finish", resolve)
      .on("error", reject);
  });
}

function inferFramePattern(frames: FrameRenderResult[], outDir: string): string | undefined {
  const first = frames[0];
  if (!first) return undefined;
  const basename = first.path.startsWith(outDir) ? first.path.slice(outDir.length + 1) : relative(outDir, first.path);
  const match = basename.match(/^(.*?)(\d+)(\.png)$/);
  if (!match) return undefined;
  const [, prefix, digits, suffix] = match;
  return join(outDir, `${prefix}%0${digits.length}d${suffix}`);
}

async function computeFileHash(path: string, algorithm: string = "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  return await new Promise<string>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
