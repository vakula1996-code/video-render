declare module "fs-extra" {
  export function mkdirp(path: string): Promise<void>;
  export function pathExists(path: string): Promise<boolean>;
}

declare module "pngjs" {
  import { Duplex } from "stream";
  import { Buffer } from "buffer";
  export interface PNGOptions {
    width?: number;
    height?: number;
    fill?: boolean;
  }
  export class PNG extends Duplex {
    constructor(options?: PNGOptions);
    width: number;
    height: number;
    data: Buffer;
    pack(): NodeJS.ReadableStream;
    on(event: "parsed", callback: (this: PNG) => void): this;
    on(event: "error", callback: (error: Error) => void): this;
  }
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
