/**
 * MIDI player: SMF note events -> WebAudio real-time synthesis.
 *
 * Why not pull in a sample library (soundfont 5-20 MB): that would blow a
 * 45 KB player straight into double-digit MB, the opposite of the "ship one
 * zip and play" goal. We use basic oscillators + envelope + low-pass
 * synthesis, with timbres approximated by GM instrument family -- the game
 * music just needs to be recognizable in melody, rhythm and harmony, not
 * sample-accurate.
 *
 * Scheduling uses the classic "dual clock" approach: a 25 ms setInterval
 * only schedules notes within the next 200 ms, leaving the precise timing to
 * AudioContext. A 50 ms timer jitter will not make the music stutter.
 */

import { isMidi, parseMidi, type MidiNoteEvent, type MidiSong } from './smf';

export interface MidiOptions {
  /** Notification on audio state changes (piped into the game log panel). */
  onLog?: (message: string) => void;
}

const LOOKAHEAD = 0.2;
const TIMER_MS = 25;
/** Concurrency cap; when exceeded, drop the new note (better to miss one note than blur into noise). */
const MAX_VOICES = 64;

type Voice = { amp: GainNode; sources: AudioScheduledSourceNode[] };

/** All synthesis parameters for one timbre. */
interface Timbre {
  waves: OscillatorType[];
  detunes: number[];
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  cutoff: number;
  peak: number;
  q: number;
  gain: number;
  /** Drum/noise-style timbres take the white-noise branch. */
  noise?: { gain: number; decay: number; hp: number; bp?: number };
  /** Layer one sine/triangle on top of the noise (e.g. snare = noise + body, kick = pure sine). */
  tone?: { freq: number; gain: number; decay: number; sweepTo?: number };
}

interface DrumHit {
  noise?: { gain: number; decay: number; hp: number; bp?: number };
  tone?: { freq: number; gain: number; decay: number; sweepTo?: number };
  gain?: number;
}

function fam(program: number): number {
  return Math.floor(program / 8);
}

/** GM instrument family -> synthesis parameters. Within family 9, programs 8/9 (glockenspiel/vibraphone) get brighter parameters on their own. */
function timbreFor(ev: MidiNoteEvent): Timbre {
  if (ev.drums) return drumHit(ev.note);
  const f = fam(ev.program);
  switch (f) {
    case 0: // Piano: triangle-dominant + slightly detuned sine for body
      return { waves: ['triangle', 'sine'], detunes: [0, 6], attack: 0.004, decay: 0.9, sustain: 0.16, release: 0.28, cutoff: 2400, peak: 3800, q: 0.7, gain: 0.5 };
    case 1: // Color drums
      return ev.program === 8
        ? { waves: ['sine', 'triangle'], detunes: [0, 1200], attack: 0.002, decay: 0.5, sustain: 0.05, release: 0.15, cutoff: 3200, peak: 3400, q: 1.1, gain: 0.42 }
        : { waves: ['sine'], detunes: [0], attack: 0.002, decay: 0.45, sustain: 0.05, release: 0.12, cutoff: 4200, peak: 4000, q: 1, gain: 0.45 };
    case 2: // Organ: sustained note
      return { waves: ['square', 'square'], detunes: [0, 9], attack: 0.012, decay: 0.06, sustain: 0.85, release: 0.12, cutoff: 2600, peak: 1200, q: 0.9, gain: 0.26 };
    case 3: // Guitar: plucked feel (fast decay)
      return { waves: ['sawtooth'], detunes: [0], attack: 0.003, decay: 0.5, sustain: 0.04, release: 0.2, cutoff: 2200, peak: 4000, q: 1.3, gain: 0.4 };
    case 4: // Bass: low-pass sine
      return { waves: ['sine', 'triangle'], detunes: [0, 5], attack: 0.006, decay: 0.3, sustain: 0.55, release: 0.12, cutoff: 820, peak: 1300, q: 1.1, gain: 0.6 };
    case 5: // Strings
    case 6: // Choir
      return { waves: ['sawtooth', 'sawtooth'], detunes: [0, 10], attack: 0.09, decay: 0.3, sustain: 0.8, release: 0.32, cutoff: 2000, peak: 1000, q: 0.6, gain: 0.28 };
    case 7: // Brass
      return { waves: ['sawtooth'], detunes: [0], attack: 0.045, decay: 0.22, sustain: 0.75, release: 0.18, cutoff: 1600, peak: 2400, q: 1.2, gain: 0.32 };
    case 8: // Reeds
      return { waves: ['square'], detunes: [0], attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.15, cutoff: 1900, peak: 1600, q: 0.9, gain: 0.28 };
    case 9: // Woodwinds (flute / suona)
      return { waves: ['sine', 'triangle'], detunes: [0, 4], attack: 0.07, decay: 0.15, sustain: 0.85, release: 0.2, cutoff: 2500, peak: 900, q: 0.5, gain: 0.34 };
    case 10: // Synth lead
      return { waves: ['square'], detunes: [0], attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.15, cutoff: 2600, peak: 2600, q: 1.5, gain: 0.28 };
    case 11: // Synth pads: slow attack
      return { waves: ['sawtooth', 'sawtooth'], detunes: [0, 13], attack: 0.16, decay: 0.4, sustain: 0.85, release: 0.5, cutoff: 1600, peak: 800, q: 0.5, gain: 0.24 };
    case 12: // Ethnic timbres
      return { waves: ['triangle'], detunes: [0], attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.25, cutoff: 2200, peak: 2200, q: 1, gain: 0.38 };
    case 13: // Percussive timbres (marimba / xylophone)
      return { waves: ['sine', 'triangle'], detunes: [0, 7], attack: 0.002, decay: 0.32, sustain: 0.04, release: 0.2, cutoff: 3000, peak: 3200, q: 1.1, gain: 0.44 };
    case 14: // Sound effects
      return { waves: ['sine'], detunes: [0], attack: 0.012, decay: 0.4, sustain: 0.4, release: 0.3, cutoff: 2800, peak: 2600, q: 2, gain: 0.28 };
    default: // 120-127 ethnic / misc
      return { waves: ['triangle'], detunes: [0], attack: 0.008, decay: 0.3, sustain: 0.6, release: 0.25, cutoff: 2400, peak: 1800, q: 0.9, gain: 0.36 };
  }
}

/** GM drum key map: turn a note number into "kick / snare / hi-hat / ride / tom / other". */
function drumHit(note: number): Timbre {
  const hit = drumHitRaw(note);
  return {
    waves: ['sine'],
    detunes: [0],
    attack: 0.001,
    decay: hit.noise?.decay ?? hit.tone?.decay ?? 0.12,
    sustain: 0,
    release: 0.02,
    cutoff: 12000,
    peak: 0,
    q: 0.7,
    gain: hit.gain ?? 0.5,
    noise: hit.noise,
    tone: hit.tone,
  };
}

function drumHitRaw(note: number): DrumHit {
  switch (note) {
    case 35: // Kick
    case 36:
      return { tone: { freq: 62, gain: 0.9, decay: 0.26, sweepTo: 42 }, gain: 0.9 };
    case 37: // Rim
      return { noise: { gain: 0.35, decay: 0.05, hp: 2500 }, gain: 0.5 };
    case 38: // Snare
    case 40:
      return { noise: { gain: 0.5, decay: 0.16, hp: 900 }, tone: { freq: 190, gain: 0.3, decay: 0.1, sweepTo: 150 }, gain: 0.6 };
    case 39: // Clap
      return { noise: { gain: 0.42, decay: 0.2, hp: 700, bp: 1600 }, gain: 0.55 };
    case 41:
    case 43:
    case 45:
    case 47:
    case 48:
    case 50: { // Toms
      const toms: Record<number, number> = { 41: 120, 43: 100, 45: 88, 47: 78, 48: 70, 50: 62 };
      const freq = toms[note] ?? 90;
      return { tone: { freq, gain: 0.6, decay: 0.28, sweepTo: freq * 0.7 }, gain: 0.6 };
    }
    case 42: // Closed hi-hat
    case 44:
      return { noise: { gain: 0.28, decay: 0.05, hp: 7000 }, gain: 0.45 };
    case 46: // Open cymbal
      return { noise: { gain: 0.26, decay: 0.3, hp: 6500 }, gain: 0.45 };
    case 51: // Splash cymbal
    case 53:
    case 59:
      return { noise: { gain: 0.3, decay: 0.55, hp: 6000 }, gain: 0.45 };
    case 49: // Ride cymbal
    case 52:
    case 55:
    case 57:
      return { noise: { gain: 0.32, decay: 1.1, hp: 4800 }, gain: 0.5 };
    default:
      return { noise: { gain: 0.3, decay: 0.1, hp: 1800 }, gain: 0.4 };
  }
}

/**
 * A single globally-shared AudioContext and bus: all players share it, saving
 * battery and nodes. The browser's autoplay policy requires one user gesture
 * first, so ctx may start suspended; this is responsible for unlocking it on
 * the first input.
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  voiceBus: GainNode | null = null;
  /** The post-mix total output node (with headroom gain applied); measure it during self-tests to get the real level. */
  output: GainNode | null = null;
  noiseBuffer: AudioBuffer | null = null;
  current: MidiPlayer | null = null;
  private unlocking = false;
  private unlockedLogged = false;

  constructor(private readonly onLog?: (message: string) => void) {}

  /** Acquire (or create) the AudioContext; returns null when the browser does not support WebAudio, with the whole chain silently degraded. */
  acquire(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.onLog?.('WebAudio not supported by the browser; MIDI will be silent');
      return null;
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = 1;
      // Polyphony cap of 64 voices; when fully stacked the bus peak can reach 1.16 (clipping).
      // Leave 5.4 dB of headroom before the limiter so the limiter only acts as a backstop, not normal operation (otherwise it would pump).
      const headroom = ctx.createGain();
      headroom.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      const bus = ctx.createGain();
      bus.connect(headroom);
      headroom.connect(comp);
      comp.connect(master);
      master.connect(ctx.destination);

      // 2 seconds of white noise, reused by drums.
      const frames = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let seed = 0x2f6e2b1;
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x3fffffff) - 1;
      }

      this.ctx = ctx;
      this.voiceBus = bus;
      this.output = headroom;
      this.noiseBuffer = buf;
      this.ensureUnlocked();
      return ctx;
    } catch (err) {
      this.onLog?.(`AudioContext creation failed: ${String(err)}`);
      return null;
    }
  }

  /** Autoplay policy: every user gesture attempts a resume; listeners are removed on success. */
  ensureUnlocked(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || this.unlocking) return;
    this.unlocking = true;
    const handler = () => {
      if (!this.ctx) return;
      void this.ctx
        .resume()
        .then(() => {
          if (this.ctx?.state === 'running') {
            for (const ev of EVENTS) globalThis.removeEventListener(ev, handler, true);
            this.unlocking = false;
            if (!this.unlockedLogged) {
              this.unlockedLogged = true;
              this.onLog?.('Audio unlocked, MIDI will start sounding');
            }
          }
        })
        .catch(() => {
          /* retry on next gesture */
        });
    };
    for (const ev of EVENTS) globalThis.addEventListener(ev, handler, true);
  }

  noiseSource(ctx: AudioContext): { source: AudioBufferSourceNode; offset: number } {
    const source = ctx.createBufferSource();
    let offset = 0;
    if (this.noiseBuffer) {
      source.buffer = this.noiseBuffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = this.noiseBuffer.duration;
      // Start playback from a different position each time, otherwise drums sound like a broken record.
      offset = Math.random() * Math.max(0, this.noiseBuffer.duration - 0.5);
    }
    return { source, offset };
  }
}

const EVENTS = ['pointerdown', 'keydown', 'touchstart', 'mousedown'] as const;

let engine: AudioEngine | null = null;

function getEngine(onLog?: (message: string) => void): AudioEngine {
  if (!engine) engine = new AudioEngine(onLog);
  return engine;
}

/**
 * Self-test hook: hand out the AudioContext and bus so external code can
 * attach an AnalyserNode and measure the real output level -- used to verify
 * "it actually makes sound" rather than just "the scheduler function was called".
 */
export function audioProbe(): { ctx: AudioContext | null; out: GainNode | null } {
  return { ctx: engine?.ctx ?? null, out: engine?.output ?? null };
}

/** Public API: turn a .mid byte stream into a start/stop-able player. On parse failure, silently degrade to no-sound. */
export class MidiPlayer {
  readonly song: MidiSong | null;
  readonly error: string | null;
  /** Self-test counters: notes scheduled into AudioContext / max concurrent voices ever observed. */
  readonly stats = { scheduled: 0, peakVoices: 0 };
  private readonly onLog?: (message: string) => void;
  private readonly engine: AudioEngine;
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private readonly voices = new Set<Voice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchor = 0;
  private index = 0;
  private cycle = 0;
  private loopCount = -1;
  private playing = false;
  private closed = false;
  private dropped = 0;
  private volumeScale = 1;
  private muted = false;

  constructor(data: Uint8Array, options: MidiOptions = {}) {
    this.onLog = options.onLog;
    this.engine = getEngine(options.onLog);
    let song: MidiSong | null = null;
    let error: string | null = null;
    try {
      song = isMidi(data) ? parseMidi(data) : null;
      if (!song) error = 'Not MIDI data';
    } catch (err) {
      error = String(err instanceof Error ? err.message : err);
    }
    this.song = song;
    this.error = song ? null : error;
    if (song) {
      this.onLog?.(
        `MIDI parsed: ${song.notes.length} notes / ${song.trackCount} tracks / ${song.duration.toFixed(1)} s`,
      );
    } else if (error) {
      this.onLog?.(`MIDI parse failed (silent): ${error}`);
    }
  }

  get durationMs(): number {
    return this.song ? Math.round(this.song.duration * 1000) : -1;
  }

  /** Number of notes dropped due to polyphony limit (for self-test / diagnostics). */
  get droppedCount(): number {
    return this.dropped;
  }

  setLoopCount(count: number): void {
    this.loopCount = count;
  }

  /** 0-1. */
  setVolume(level: number): void {
    this.volumeScale = Math.max(0, Math.min(1, level));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.out || !this.ctx) return;
    const value = this.muted ? 0 : this.volumeScale;
    this.out.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  start(): void {
    if (this.closed || this.playing) return;
    this.playing = true;
    if (!this.song) return; // parse failed / not MIDI: keep the "started" semantics but stay silent
    const ctx = this.engine.acquire();
    if (!ctx || !this.engine.voiceBus) return; // no WebAudio: silent as well
    this.ctx = ctx;
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.connect(this.engine.voiceBus);
    }
    this.applyGain();
    // On a phone only one player is audible at a time; kill the previous one before switching songs.
    if (this.engine.current && this.engine.current !== this) this.engine.current.stop();
    this.engine.current = this;

    this.anchor = ctx.currentTime + 0.08;
    this.index = 0;
    this.cycle = 0;
    this.dropped = 0;
    this.engine.ensureUnlocked();
    this.timer = setInterval(() => this.pump(), TIMER_MS);
    this.pump();
  }

  stop(): void {
    if (!this.playing && !this.ctx) {
      this.playing = false;
      return;
    }
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.silenceVoices();
    if (this.engine.current === this) this.engine.current = null;
    if (this.dropped > 0) {
      this.onLog?.(`Polyphony limit exceeded, dropped ${this.dropped} notes`);
      this.dropped = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.stop();
    this.closed = true;
    this.out?.disconnect();
    this.out = null;
  }

  /** Scheduling: only queue notes within the next LOOKAHEAD seconds into the AudioContext. */
  private pump(): void {
    if (!this.playing || !this.ctx || !this.song) return;
    const ctx = this.ctx;
    const notes = this.song.notes;
    const duration = this.song.duration;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const totalPasses = this.loopCount < 0 ? Infinity : this.loopCount + 1;
    let guard = 0;
    for (;;) {
      if (guard++ > 8192) break;
      if (this.index >= notes.length) {
        if (this.cycle + 1 >= totalPasses) {
          this.stop();
          return;
        }
        this.cycle++;
        this.index = 0;
        continue;
      }
      const ev = notes[this.index];
      const when = this.anchor + this.cycle * duration + ev.time;
      if (when > horizon) break;
      this.playNote(ev, when);
      this.index++;
    }
  }

  private playNote(ev: MidiNoteEvent, when: number): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out) return;
    if (this.voices.size >= MAX_VOICES) {
      this.dropped++;
      return;
    }
    const tb = timbreFor(ev);
    const level = Math.pow(ev.velocity / 127, 1.35) * ev.volume * this.volumeScale;
    if (level < 0.004) return;

    const mix = ctx.createGain();
    mix.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = tb.q;
    const sources: AudioScheduledSourceNode[] = [];

    // Drums: noise + drum body, two layers stacked.
    if (tb.noise) {
      const { source: src, offset } = this.engine.noiseSource(ctx);
      const ng = ctx.createGain();
      const decay = tb.noise.decay;
      ng.gain.setValueAtTime(0.0001, when);
      ng.gain.linearRampToValueAtTime(tb.noise.gain * level, when + 0.001);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      if (tb.noise.bp) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = tb.noise.bp;
        src.connect(bp);
        bp.connect(ng);
      } else {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = tb.noise.hp;
        src.connect(hp);
        hp.connect(ng);
      }
      ng.connect(mix);
      src.start(when, offset);
      sources.push(src);
    }

    if (tb.tone) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const tg = ctx.createGain();
      osc.frequency.setValueAtTime(tb.tone.freq, when);
      if (tb.tone.sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, tb.tone.sweepTo), when + tb.tone.decay);
      }
      tg.gain.setValueAtTime(0.0001, when);
      tg.gain.linearRampToValueAtTime(tb.tone.gain * level, when + 0.002);
      tg.gain.exponentialRampToValueAtTime(0.0001, when + tb.tone.decay);
      osc.connect(tg);
      tg.connect(mix);
      osc.start(when);
      sources.push(osc);
    }

    if (sources.length === 0) {
      // Melodic timbre: build a set of oscillators from waves.
      const freq = 440 * Math.pow(2, (ev.note - 69) / 12);
      for (let i = 0; i < tb.waves.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = tb.waves[i];
        osc.frequency.value = freq;
        osc.detune.value = tb.detunes[i] ?? 0;
        const g = ctx.createGain();
        g.gain.value = tb.gain / tb.waves.length;
        osc.connect(g);
        g.connect(mix);
        osc.start(when);
        sources.push(osc);
      }
      const openAt = when + Math.max(tb.attack + tb.decay, Math.min(ev.duration, 2));
      filter.frequency.setValueAtTime(Math.min(18000, tb.cutoff + tb.peak * level), when);
      filter.frequency.exponentialRampToValueAtTime(Math.max(180, tb.cutoff), openAt);
      this.applyAdsr(mix, when, tb, ev.duration);
    } else {
      filter.frequency.value = 18000;
      filter.Q.value = 0.5;
    }

    const amp = ctx.createGain();
    amp.gain.value = 1;
    mix.connect(filter);
    filter.connect(amp);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, ev.pan));
    amp.connect(panner);
    panner.connect(out);

    const stopAt = when + Math.max(ev.duration, tb.attack + tb.decay) + tb.release + 0.1;
    const voice: Voice = { amp, sources };
    this.voices.add(voice);
    this.stats.scheduled++;
    if (this.voices.size > this.stats.peakVoices) this.stats.peakVoices = this.voices.size;
    for (const src of sources) {
      try {
        src.stop(stopAt);
      } catch {
        /* already stopped */
      }
    }
    // Reclaim node references when the last source ends.
    const last = sources[sources.length - 1];
    if (last) {
      last.onended = () => {
        this.voices.delete(voice);
        try {
          amp.disconnect();
          panner.disconnect();
          filter.disconnect();
          mix.disconnect();
        } catch {
          /* already disconnected */
        }
      };
    }
  }

  private applyAdsr(node: GainNode, when: number, tb: Timbre, duration: number): void {
    const param = node.gain;
    const peak = 1;
    const sustain = Math.max(0.0005, peak * tb.sustain);
    const off = when + Math.max(duration, tb.attack + tb.decay);
    param.setValueAtTime(0.0001, when);
    param.linearRampToValueAtTime(peak, when + tb.attack);
    param.exponentialRampToValueAtTime(sustain, when + tb.attack + tb.decay);
    param.setValueAtTime(sustain, off);
    param.exponentialRampToValueAtTime(0.0001, off + tb.release);
  }

  private silenceVoices(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.voices.clear();
      return;
    }
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.amp.gain.cancelScheduledValues(now);
      voice.amp.gain.setTargetAtTime(0, now, 0.015);
      for (const src of voice.sources) {
        try {
          src.stop(now + 0.06);
        } catch {
          /* already stopped */
        }
      }
    }
  }
}