import EventEmitter from "eventemitter3";
import * as Tone from "tone";
import Meyda from "meyda";
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
  private connected = false;
  private connectTask: Promise<void> | null = null;
  private readonly options: Required<AudioControllerOptions>;
  private harmony?: Tone.PolySynth<Tone.Synth>;
  private bass?: Tone.MonoSynth;
  private hats?: Tone.NoiseSynth;

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

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.connectTask) {
      return this.connectTask;
    }

    this.connectTask = (async () => {
      const startPromise = Tone.start();
      let timeout: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          startPromise,
          new Promise<void>((_, reject) => {
            timeout = setTimeout(() => {
              reject(new Error("Tone.js start timeout"));
            }, 2000);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      if (this.connected) {
        return;
      }

      await startPromise;
      Tone.Transport.bpm.value = this.options.bpm;
      Tone.Transport.scheduleRepeat((time) => {
        this.emitBeat("beat", time);
      }, "4n");

      Tone.Transport.scheduleRepeat((time) => {
        if (this.beatIndex % this.options.beatsPerBar === 0) {
          this.emitBeat("bar", time);
        }
      }, `${this.options.beatsPerBar}n`);

      this.bootstrapSynths();

      Tone.Transport.start();
      this.connected = true;
    })();

    try {
      await this.connectTask;
    } finally {
      this.connectTask = null;
    }
  }

  private emitBeat(event: AudioEventName, time: number): void {
    const payload: AudioBeatEvent = { time, index: this.beatIndex++ };
    this.emit(event, payload);
    this.engine?.emit(`audio:${event}`, payload as never);
  }

  private bootstrapSynths(): void {
    if (this.harmony || this.bass || this.hats) {
      return;
    }

    Tone.Destination.volume.value = -10;

    this.harmony = new Tone.PolySynth(Tone.Synth).toDestination();
    this.harmony.maxPolyphony = 4;
    this.harmony.set({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.04, decay: 0.3, sustain: 0.4, release: 1.2 },
    });

    this.bass = new Tone.MonoSynth().toDestination();
    this.bass.set({
      oscillator: { type: "square" },
      filter: { type: "lowpass", rolloff: -24, frequency: 180 },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.6 },
      filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.4, baseFrequency: 120, octaves: 2.5 },
    });

    this.hats = new Tone.NoiseSynth().toDestination();
    this.hats.set({
      envelope: { attack: 0.001, decay: 0.09, sustain: 0 },
      volume: -14,
    });

    const chords: Array<[string, string, string]> = [
      ["C4", "Eb4", "G4"],
      ["Bb3", "Eb4", "G4"],
      ["Ab3", "C4", "F4"],
      ["G3", "Bb3", "D4"],
    ];
    let chordStep = 0;
    Tone.Transport.scheduleRepeat((time) => {
      const chord = chords[chordStep % chords.length];
      this.harmony?.triggerAttackRelease(chord, "2n", time, 0.5);
      chordStep++;
    }, "1m");

    const bassline = ["C2", "C2", "Bb1", "G1"];
    let bassStep = 0;
    Tone.Transport.scheduleRepeat((time) => {
      const note = bassline[bassStep % bassline.length];
      const velocity = bassStep % 4 === 0 ? 0.9 : 0.6;
      this.bass?.triggerAttackRelease(note, "8n", time, velocity);
      bassStep++;
    }, "2n");

    let hatStep = 0;
    Tone.Transport.scheduleRepeat((time) => {
      const velocity = hatStep % 4 === 0 ? 0.7 : 0.35;
      this.hats?.triggerAttackRelease("16n", time, velocity);
      hatStep++;
    }, "8n");
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
      const features = Meyda.extract("amplitudeSpectrum", slice) as number[] | null;
      if (!features) continue;
      const fft = Float32Array.from(features);
      const time = (i / samples.length) * (samples.length / 44100) * 1000;
      fftEvents.push({ time, fft });
    }
    return fftEvents;
  }
}

async function loadAudioBuffer(path: string): Promise<Float32Array> {
  const { createReadStream } = await import("node:fs");
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
