import EventEmitter from "eventemitter3";
import * as Tone from "tone";
import Meyda from "meyda";
import { createReadStream } from "fs";
import type { AudioPlugin, AudioBeatEvent, AudioFFTEvent, VisEngine } from "@vis/core";

export interface AudioControllerEvents {
  beat: AudioBeatEvent;
  bar: AudioBeatEvent;
  fft: AudioFFTEvent;
}

type AudioEventName = keyof AudioControllerEvents;

export interface AudioControllerOptions {
  /**
   * Audio file used when rendering offline.
   */
  offlineAudioPath?: string;
  bpm?: number;
  beatsPerBar?: number;
}

/**
 * Real-time audio driver for the visualization engine. Uses Tone.js for scheduling and Meyda for feature extraction.
 */
export class AudioController extends EventEmitter<AudioControllerEvents> implements AudioPlugin {
  readonly name = "@vis/audio";
  private engine?: VisEngine;
  private beatIndex = 0;
  private readonly options: Required<AudioControllerOptions>;

  constructor(options: AudioControllerOptions = {}) {
    super();
    this.options = {
      offlineAudioPath: options.offlineAudioPath ?? "assets/audio/demo.mp3",
      bpm: options.bpm ?? 120,
      beatsPerBar: options.beatsPerBar ?? 4,
    };
  }

  async setup(engine: VisEngine): Promise<void> {
    this.engine = engine;
  }

  async connect(): Promise<void> {
    await Tone.start();
    Tone.Transport.bpm.value = this.options.bpm;
    Tone.Transport.scheduleRepeat((time) => {
      this.emitBeat("beat", time);
    }, "4n");

    Tone.Transport.scheduleRepeat((time) => {
      if (this.beatIndex % this.options.beatsPerBar === 0) {
        this.emitBeat("bar", time);
      }
    }, `${this.options.beatsPerBar}n`);

    Tone.Transport.start();
  }

  private emitBeat(event: AudioEventName, time: number): void {
    const payload: AudioBeatEvent = { time, index: this.beatIndex++ };
    this.emit(event, payload);
    this.engine?.emit(`audio:${event}`, payload as never);
  }

  /**
   * Offline Meyda analysis for deterministic FFT/beat extraction.
   */
  async analyzeFile(path = this.options.offlineAudioPath): Promise<AudioFFTEvent[]> {
    const samples = await loadAudioBuffer(path);
    const fftEvents: AudioFFTEvent[] = [];
    const hop = 1024;
    for (let i = 0; i < samples.length; i += hop) {
      const slice = samples.subarray(i, i + hop);
      if (slice.length < hop) break;
      const features = Meyda.extract("amplitudeSpectrum", slice);
      if (!features) continue;
      const fft = Float32Array.from(features);
      const time = (i / samples.length) * (samples.length / 44100) * 1000;
      fftEvents.push({ time, fft });
    }
    return fftEvents;
  }
}

async function loadAudioBuffer(path: string): Promise<Float32Array> {
  const stream = createReadStream(path);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  // Placeholder: decode audio data with Web Audio API offline context when implemented.
  // For now we expose raw PCM assumption for future pipeline integration.
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export async function analyzeAudioFile(path: string): Promise<void> {
  const controller = new AudioController({ offlineAudioPath: path });
  const fftEvents = await controller.analyzeFile(path);
  console.log(`Analyzed ${fftEvents.length} FFT frames from ${path}`);
}
