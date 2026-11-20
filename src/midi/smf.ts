/**
 * Standard MIDI File (SMF) parser: turns .mid byte streams into "note events
 * with absolute time".
 *
 * Why write our own instead of using a library: the cost floor of the whole
 * approach is "player 45 KB, zero dependencies". Pulling in an npm package
 * like midi-js brings in tens of KB of deps, and they only give you events
 * -- no time axis. The truly tricky parts (tempo map / running status / multi-
 * track merging) still have to be hand-rolled.
 *
 * Coverage is scoped to actual J2ME resources: the 11 .mid files in this
 * project's jar are all format 0/1, division 96-480 ticks/quarter note, up
 * to 19 tracks, 16 channels, with a drum channel. No SMPTE time base
 * (division high bit set) edge cases.
 * The tempo map is fully implemented -- variable tempo is a MIDI basic; we
 * cannot assume constant speed.
 */

/** A note with its start and end time already determined. */
export interface MidiNoteEvent {
  /** Seconds from the start of the song. */
  time: number;
  /** Duration of the sound (seconds). */
  duration: number;
  /** 0-15. */
  channel: number;
  /** 0-127; 60 = middle C. */
  note: number;
  /** 1-127. */
  velocity: number;
  /** GM program number 0-127 in effect at the onset. */
  program: number;
  /** Whether this is a drum channel (GM convention: 10th channel = index 9). */
  drums: boolean;
  /** -1..1, from CC10. */
  pan: number;
  /** 0..1, from CC7. */
  volume: number;
}

export interface MidiSong {
  notes: MidiNoteEvent[];
  /** Length of one pass through the song (seconds), including tail margin. */
  duration: number;
  division: number;
  trackCount: number;
  format: number;
}

/** Temporary record used during parsing: store tick first, convert to seconds after the pass. */
interface PendingNote {
  ev: MidiNoteEvent;
  tickStart: number;
  tickEnd: number;
}

const MTHD = 0x4d546864; // 'MThd' (upper M T, lower h d)
const MTRK = 0x4d54726b; // 'MTrk'

/** Tail margin: the release of the last note must finish sounding, so the loop point does not cut hard. */
const TAIL_SECONDS = 0.35;

/** Drum channel index (GM's 10th channel). */
const DRUM_CHANNEL = 9;

export function isMidi(data: Uint8Array): boolean {
  return data.length >= 14 && readTag(data, 0) === MTHD;
}

function readTag(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function readU32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

/** MIDI variable-length quantity (VLQ): 7 bits per byte, high bit means "more follows". */
function readVlq(d: Uint8Array, o: number): { value: number; next: number } {
  let value = 0;
  let p = o;
  for (let i = 0; i < 4 && p < d.length; i++) {
    const b = d[p++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return { value, next: p };
  }
  return { value, next: p };
}

/** Tempo segment: from this tick, microseconds per quarter note. */
interface TempoPoint {
  tick: number;
  usPerQuarter: number;
}

export function parseMidi(data: Uint8Array): MidiSong {
  if (!isMidi(data)) throw new Error('Not a Standard MIDI File (missing MThd)');
  const headerLen = readU32(data, 4);
  const format = (data[8] << 8) | data[9];
  const declaredTracks = (data[10] << 8) | data[11];
  const division = (data[12] << 8) | data[13];

  // SMPTE time base (division high bit set): frames/second + ticks per frame.
  // J2ME resources almost never use it, but converting to approximate seconds
  // is better than throwing.
  const smpte = (division & 0x8000) !== 0;
  const secondsPerTick = smpte ? 1 / Math.max(1, (256 - (data[12] & 0xff)) * data[13]) : 1 / Math.max(1, division);

  const tempos: TempoPoint[] = [{ tick: 0, usPerQuarter: 500000 }];
  const pending: PendingNote[] = [];
  const programs = new Map<number, number>();
  const volumes = new Map<number, number>();
  const pans = new Map<number, number>();
  /** The same (channel, pitch) may overlap; use a stack to pair note on/off. */
  const active = new Map<number, PendingNote[]>();
  let maxTick = 0;
  let trackCount = 0;

  let pos = 8 + headerLen;
  while (pos + 8 <= data.length && readTag(data, pos) === MTRK) {
    const trackLen = readU32(data, pos + 4);
    const end = Math.min(pos + 8 + trackLen, data.length);
    pos += 8;
    trackCount++;

    let tick = 0;
    let running = 0;
    while (pos < end) {
      const dt = readVlq(data, pos);
      pos = dt.next;
      tick += dt.value;
      if (tick > maxTick) maxTick = tick;

      let status = data[pos];
      if (status === undefined) break;
      if (status & 0x80) {
        running = status;
        pos++;
      } else {
        status = running;
      }
      if (status === 0 || pos >= end) break; // missing running status / fell outside the track

      const type = status & 0xf0;
      const channel = status & 0x0f;

      switch (type) {
        case 0x80: {
          const note = data[pos];
          pos += 2;
          release(active, channel, note, tick);
          break;
        }
        case 0x90: {
          const note = data[pos];
          const velocity = data[pos + 1];
          pos += 2;
          if (velocity > 0) {
            const program = programs.get(channel) ?? 0;
            const rec: PendingNote = {
              ev: {
                time: 0,
                duration: 0,
                channel,
                note,
                velocity,
                program,
                // Drum convention is index 9; if the channel explicitly switched to a non-zero program, treat it as a regular instrument.
                drums: channel === DRUM_CHANNEL && program === 0,
                pan: pans.get(channel) ?? 0,
                volume: (volumes.get(channel) ?? 127) / 127,
              },
              tickStart: tick,
              tickEnd: tick,
            };
            pending.push(rec);
            const key = channel * 128 + note;
            const stack = active.get(key);
            if (stack) stack.push(rec);
            else active.set(key, [rec]);
          } else {
            release(active, channel, note, tick);
          }
          break;
        }
        case 0xa0: // poly aftertouch
        case 0xe0: // pitch bend
          pos += 2;
          break;
        case 0xb0: {
          const controller = data[pos];
          const value = data[pos + 1];
          pos += 2;
          if (controller === 7) volumes.set(channel, value);
          else if (controller === 10) pans.set(channel, (value / 127 - 0.5) * 2);
          break;
        }
        case 0xc0: // program change
          programs.set(channel, data[pos]);
          pos += 1;
          break;
        case 0xd0: // channel aftertouch
          pos += 1;
          break;
        case 0xf0: {
          if (status !== 0xff) {
            const len = readVlq(data, pos);
            pos = len.next + len.value; // skip the whole sysex
            break;
          }
          const meta = data[pos];
          pos += 1;
          const len = readVlq(data, pos);
          pos = len.next;
          if (meta === 0x51 && len.value === 3 && pos + 3 <= data.length) {
            const usPerQuarter = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
            const last = tempos[tempos.length - 1];
            if (last.tick !== tick) tempos.push({ tick, usPerQuarter });
          }
          pos += len.value;
          if (meta === 0x2f) break; // end of track
          break;
        }
        default:
          pos = end;
          break;
      }
    }
    pos = end;
  }

  // Hung notes (some files do not write a final note off) get a fallback length so they do not ring for the whole song.
  for (const stack of active.values()) {
    for (const rec of stack) if (rec.tickEnd <= rec.tickStart) rec.tickEnd = rec.tickStart + 1;
  }

  tempos.sort((a, b) => a.tick - b.tick);
  const toSeconds = smpte ? (tick: number): number => tick * secondsPerTick : makeTickConverter(tempos, Math.max(1, division));

  const notes: MidiNoteEvent[] = [];
  for (const rec of pending) {
    rec.ev.time = toSeconds(rec.tickStart);
    rec.ev.duration = Math.max(0.04, toSeconds(rec.tickEnd) - rec.ev.time);
    notes.push(rec.ev);
  }
  notes.sort((a, b) => a.time - b.time);

  if (!notes.length) throw new Error('No note events in the MIDI');
  // Some old files misreport track count/length; silently accept what was actually parsed.
  void declaredTracks;
  return { notes, duration: Math.max(1, toSeconds(maxTick) + TAIL_SECONDS), division, trackCount, format };
}

/** Build the tick->seconds conversion function: piecewise linear, slope changes at tempo changes. */
function makeTickConverter(tempos: TempoPoint[], division: number): (tick: number) => number {
  const segs = tempos.map((tp) => ({ tick: tp.tick, seconds: 0, rate: tp.usPerQuarter / (division * 1e6) }));
  for (let i = 1; i < segs.length; i++) {
    segs[i].seconds = segs[i - 1].seconds + (segs[i].tick - segs[i - 1].tick) * segs[i - 1].rate;
  }
  const last = segs[segs.length - 1];
  return (tick: number): number => {
    if (tick <= last.tick) {
      let i = segs.length - 1;
      while (i > 0 && segs[i].tick > tick) i--;
      const seg = segs[i];
      return seg.seconds + (tick - seg.tick) * seg.rate;
    }
    // The last tempo segment continues to the end of the song.
    return last.seconds + (tick - last.tick) * last.rate;
  };
}

function release(active: Map<number, PendingNote[]>, channel: number, note: number, tick: number): void {
  const stack = active.get(channel * 128 + note);
  if (!stack || stack.length === 0) return;
  const rec = stack.pop()!;
  rec.tickEnd = tick;
  if (stack.length === 0) active.delete(channel * 128 + note);
}