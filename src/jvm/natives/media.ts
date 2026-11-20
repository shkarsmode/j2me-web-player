import type { Jvm, JThread, NativeClassDef } from '../jvm';
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import { JArray, JObject } from '../types';
import { newNativeObject } from './helpers';
import { readAllBytes } from './io';
import { MidiPlayer } from '../../midi/synth';

/**
 * javax.microedition.media stub + **real MIDI playback**.
 *
 * Upstream 0.0.x has no such package at all: "media" only appears in lang.ts's
 * exception class mapping. Any game that calls Manager/Player gets a
 * NoClassDefFoundError (jvm.ts:162); if the game retries on every repaint
 * that turns into an exception storm -- the root cause of "enabling sound
 * freezes the game".
 *
 * Class and method **signatures** follow CLDC/MIDP 2.0, and the descriptors
 * must match the jar's constant pool verbatim (see the getControl note on
 * playerClass below).
 *
 * Playback itself is real WebAudio synthesis: the music resources in the jar
 * are standard .mid files (11 measured in practice, format 0/1, up to 19
 * tracks, including a drum channel). createPlayer(InputStream,"audio/midi")
 * reads the byte stream, parses it, and the synth in src/midi/synth.ts plays
 * it in real time. Non-MIDI data (wav/amr/etc.) still takes the silent path.
 *
 * State constants (javax.microedition.media.Player):
 *   REALIZED 4 / PREFETCHED 8 / STARTED 16 / CLOSED 32 / ERROR 0
 */

/** javax.microedition.media.Player state constants (real MIDP values). */
const UNREALIZED = 100;
const REALIZED = 4;
const PREFETCHED = 8;
const STARTED = 16;
const CLOSED = 32;

const LOOP_INDEFINITE = -1;

/** VolumeControl's internal state: bound to a specific Player so setLevel actually affects that song. */
interface VolumePeer {
  owner: MidiPlayer | null;
  level: number;
  muted: boolean;
}

/** Per-instance playback state; integer state not stored on self.n lives in a peer object. */
interface PlayerPeer {
  state: number;
  loopMode: number;
  loopCount: number;
  /** Real MIDI player; null on parse failure or non-MIDI input (silent). */
  midi: MidiPlayer | null;
  /** One VolumeControl per Player; getControl always returns the same instance (real semantics). */
  volume: JObject | null;
  /** Back-reference so VolumeControl can look up its Player. */
  self: JObject | null;
}

function newVolumePeer(owner: MidiPlayer | null): VolumePeer {
  return { owner, level: 100, muted: false };
}

/** Create a new Player object; real-parse and attach the synth when MIDI is present. */
function newPlayer(jvm: Jvm, data: Uint8Array | null): JObject {
  let midi: MidiPlayer | null = null;
  if (data && data.length >= 4) {
    midi = new MidiPlayer(data, { onLog: (message) => jvm.host.log('info', message) });
  }
  const self = newNativeObject(jvm, 'javax/microedition/media/Player', null);
  const peer: PlayerPeer = {
    state: midi && !midi.error ? REALIZED : STARTED,
    loopMode: LOOP_INDEFINITE,
    loopCount: -1,
    midi,
    volume: null,
    self,
  };
  self.n = peer;
  if (midi && !midi.error) peer.volume = newNativeObject(jvm, 'j2me/VolumeControlImpl', newVolumePeer(midi));
  return self;
}

/** Legacy "pretend playing" path: no byte stream (URL / system sounds) keeps the old semantics. */
function newStartedPlayer(jvm: Jvm): JObject {
  return newPlayer(jvm, null);
}

function peerOf(self: JObject): PlayerPeer {
  if (self.n === undefined || self.n === null) {
    self.n = { state: UNREALIZED, loopMode: LOOP_INDEFINITE, loopCount: -1, midi: null, volume: null, self } satisfies PlayerPeer;
  }
  return self.n as PlayerPeer;
}

function volumePeer(self: JObject): VolumePeer {
  if (typeof self.n !== 'object' || self.n === null) self.n = newVolumePeer(null);
  return self.n as VolumePeer;
}

/** Player.getVolume() goes through its own VolumeControl instance. */
function volumePeerOf(p: PlayerPeer): VolumePeer {
  return volumePeer(p.volume as JObject);
}

/** Unified state transition: any playback call after CLOSED throws MediaException (MIDP semantics). */
function enter(t: JThread, self: JObject, next: number): void {
  const p = peerOf(self);
  if (p.state === CLOSED) throw t.jvm.throwable('javax/microedition/media/MediaException', 'player is closed');
  p.state = next;
}

const mediaException: NativeClassDef = {
  name: 'javax/microedition/media/MediaException',
  super: 'java/lang/Exception',
};

const playerListener: NativeClassDef = {
  name: 'javax/microedition/media/PlayerListener',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

/** javax.microedition.media.Control: base class of all controls (in the media package under MIDP 2.0). */
const controlClass: NativeClassDef = {
  name: 'javax/microedition/media/Control',
  super: 'java/lang/Object',
};

/** Controllable: interface implemented by Player, exposing getControl/getControls. */
const controllableClass: NativeClassDef = {
  name: 'javax/microedition/media/Controllable',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
  methods: {
    'getControl(Ljava/lang/String;)Ljavax/microedition/media/Control;': () => null,
    'getControls()[Ljavax/microedition/media/Control;': () => new JArray('[Ljavax/microedition/media/Control;', []),
  },
};

const volumeControlInterface: NativeClassDef = {
  name: 'javax/microedition/media/control/VolumeControl',
  interfaces: ['javax/microedition/media/Control'],
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

/**
 * Concrete implementation of the volume control. After a game obtains a
 * Player it typically does:
 *   player.getControl("VolumeControl") -> checkcast VolumeControl -> setLevel(x)
 * so getControl must return an object that is really `instanceof
 * VolumeControl`, and it must be bound to this Player's MIDI synth so that
 * setLevel actually changes that song's volume.
 */
const volumeControlImpl: NativeClassDef = {
  name: 'j2me/VolumeControlImpl',
  interfaces: ['javax/microedition/media/control/VolumeControl'],
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = newVolumePeer(null);
    },
    'getLevel()I': (_t, [self]) => volumePeer(self).level,
    'setLevel(I)I': (t, [self, level]) => {
      if (level < 0 || level > 100) throw t.jvm.throwable('java/lang/IllegalArgumentException', `level ${level}`);
      const peer = volumePeer(self);
      peer.level = level;
      peer.owner?.setVolume(level / 100);
      return level;
    },
    'isMute()Z': (_t, [self]) => volumePeer(self).muted,
    'setMute(Z)V': (_t, [self, mute]) => {
      const peer = volumePeer(self);
      peer.muted = mute !== false;
      peer.owner?.setMuted(peer.muted);
    },
  },
};

const playerClass: NativeClassDef = {
  name: 'javax/microedition/media/Player',
  interfaces: ['javax/microedition/media/Controllable'],
  fields: {
    UNREALIZED: UNREALIZED,
    REALIZED,
    PREFETCHED,
    STARTED,
    CLOSED,
    ERROR: 0,
  },
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = { state: UNREALIZED, loopMode: LOOP_INDEFINITE, loopCount: -1, midi: null, volume: null, self } satisfies PlayerPeer;
    },
    // ---- lifecycle: realize/prefetch do not actually pre-read; start begins sounding ----
    'realize()V': (t, [self]) => enter(t, self, REALIZED),
    'prefetch()V': (t, [self]) => enter(t, self, PREFETCHED),
    'prepare()V': (t, [self]) => enter(t, self, PREFETCHED),
    'start()V': (t, [self]) => {
      const p = peerOf(self);
      enter(t, self, STARTED);
      p.midi?.setLoopCount(p.loopCount);
      p.midi?.start();
    },
    'stop()V': (t, [self]) => {
      const p = peerOf(self);
      enter(t, self, PREFETCHED);
      p.midi?.stop();
    },
    'close()V': (t, [self]) => {
      const p = peerOf(self);
      if (p.state === CLOSED) throw t.jvm.throwable('javax/microedition/media/MediaException', 'player already closed');
      p.midi?.close();
      p.state = CLOSED;
      p.volume = null;
      p.self = null;
    },
    'release()V': (t, [self]) => {
      peerOf(self).midi?.close();
      peerOf(self).state = CLOSED;
    },
    'reset()V': (t, [self]) => {
      const p = peerOf(self);
      p.midi?.stop();
      p.state = UNREALIZED;
    },
    'deallocate()V': () => {},

    // ---- state queries ----
    'getState()I': (_t, [self]) => peerOf(self).state,
    'getLoopMode()I': (_t, [self]) => peerOf(self).loopMode,
    'getLoopCount()I': (_t, [self]) => peerOf(self).loopCount,
    'getDuration()I': (_t, [self]) => Math.round((peerOf(self).midi?.durationMs ?? -1) * 1000),
    'getMediaType()Ljava/lang/String;': () => 'audio/midi',
    'getContentType(Ljava/lang/String;)Ljava/lang/String;': (_t, [, type]) => type,
    'getLongDuration()J': (_t, [self]) => BigInt(peerOf(self).midi?.durationMs ?? -1),

    // ---- parameter settings ----
    'setLoopMode(I)V': (t, [self, mode]) => {
      const p = peerOf(self);
      p.loopMode = mode;
      p.loopCount = mode === 0 ? 1 : LOOP_INDEFINITE;
      p.midi?.setLoopCount(p.loopCount);
    },
    'setLoopCount(I)V': (t, [self, count]) => {
      const p = peerOf(self);
      p.loopCount = count;
      p.midi?.setLoopCount(count);
    },
    'setPriority(I)V': () => {},
    'setMediaLocator(Ljavax/microedition/media/MediaLocator;)V': () => {},
    'getMediaLocator()Ljavax/microedition/media/MediaLocator;': () => null,
    // The descriptor must match the jar's constant pool verbatim, otherwise invokevirtual cannot find the implementation -> AbstractMethodError
    'getControl(Ljava/lang/String;)Ljavax/microedition/media/Control;': (t, [self, name]) => {
      if (name !== 'VolumeControl') return null;
      const p = peerOf(self);
      if (!p.volume) p.volume = newNativeObject(t.jvm, 'j2me/VolumeControlImpl', newVolumePeer(p.midi));
      return p.volume;
    },
    'getControls()[Ljavax/microedition/media/Control;': (t, [self]) => {
      const p = peerOf(self);
      return new JArray('[Ljavax/microedition/media/Control;', p.volume ? [p.volume] : []);
    },

    // ---- listeners: registration only, no event dispatch ----
    'addPlayerListener(Ljavax/microedition/media/PlayerListener;)V': () => {},
    'removePlayerListener(Ljavax/microedition/media/PlayerListener;)V': () => {},

    // ---- volume: the real API is on the control; also forward for legacy code ----
    'setVolume(I)V': (t, [self, level]) => {
      const p = peerOf(self);
      if (level < 0 || level > 100) throw t.jvm.throwable('java/lang/IllegalArgumentException', `level ${level}`);
      p.midi?.setVolume(level / 100);
    },
    'getVolume()I': (_t, [self]) => volumePeerOf(peerOf(self)).level,

    // ---- common extension methods that some older games call directly ----
    'setDataSource(Ljava/lang/String;)V': () => {},
    'getVideoCodecInfo()Ljava/lang/String;': () => null,
    'getVideoWidth()I': () => -1,
    'getVideoHeight()I': () => -1,
  },
};

const managerClass: NativeClassDef = {
  name: 'javax/microedition/media/Manager',
  statics: {
    // Note: static method arguments are the raw stack values, with no receiver
    // placeholder. Writing (t, [, stream]) would treat the 2nd argument (the type
    // string) as the stream, and readAllBytes on a string -> undefined.vcache.
    // No byte-stream path (URL / system sounds): keep the "already playing"
    // semantics but do not actually sound.
    'createPlayer(Ljava/lang/String;)Ljavax/microedition/media/Player;': (t, [url]) => {
      if (url === null) throw t.jvm.npe('url');
      return newStartedPlayer(t.jvm);
    },
    // Real playback path: read the stream's bytes and hand them to the MIDI synth
    'createPlayer(Ljava/io/InputStream;Ljava/lang/String;)Ljavax/microedition/media/Player;': (t, [stream]) => {
      if (stream === null) throw t.jvm.npe('stream');
      return newPlayer(t.jvm, slurp(t, stream));
    },
    'createPlayer(Ljava/io/InputStream;)Ljavax/microedition/media/Player;': (t, [stream]) => {
      if (stream === null) throw t.jvm.npe('stream');
      return newPlayer(t.jvm, slurp(t, stream));
    },
    // MIDI device: older games often ask "is MIDI available?" first
    'getMidiSystem()Ljavax/microedition/media/spi/MidiSystem;': () => null,
    'getSupportedContentTypes(Ljava/lang/String;)[Ljava/lang/String;': () => new JArray('[Ljava/lang/String;', []),
    'getAudioInfo(Ljavax/microedition/media/AudioInfo;)V': () => {},
    'getSystemSound(Ljava/lang/String;)Ljavax/microedition/media/Player;': (t) => newStartedPlayer(t.jvm),
    'playTone(IILjava/io/InputStream;)V': () => {},
    'playTone(I)V': () => {},
    'getPlyBtnOrder()I': () => 0,
    'setPlyBtnOrder(I)V': () => {},
  },
};

const toneSequence: NativeClassDef = {
  name: 'javax/microedition/media/control/ToneSequence',
  methods: {
    '<init>([B)V': () => {},
    'getSequence()[B': () => null,
  },
};

const tonePlayerClass: NativeClassDef = {
  name: 'javax/microedition/media/TonePlayer',
  methods: {
    '<init>(Ljavax/microedition/media/control/ToneSequence;)V': () => {},
    'play()V': () => {},
    'stop()V': () => {},
  },
};

const midiDevice: NativeClassDef = {
  name: 'javax/microedition/media/spi/MidiDevice',
  methods: {
    'getChannels()I': () => 0,
    'isOpen()Z': () => false,
    'open()V': () => {},
    'close()V': () => {},
  },
};

/** Read all bytes from the stream; on failure fall back to silent (do not let one bad stream crash the whole game). */
function slurp(t: JThread, stream: JObject): Uint8Array | null {
  try {
    return readAllBytes(t, stream);
  } catch (err) {
    t.jvm.host.log('warn', `Failed to read media stream (silent): ${String(err)}`);
    return null;
  }
}

/** javax.microedition.io.Connection: only adds close(), enough for legacy "close the connection when done" code. */
const connectionClass: NativeClassDef = {
  name: 'javax/microedition/io/Connection',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
  methods: {
    'close()V': () => {},
  },
};

/** InputConnection extends Connection (MIDP 1.0 inheritance direction; do not invert into a cycle). */
const inputConnectionClass: NativeClassDef = {
  name: 'javax/microedition/io/InputConnection',
  interfaces: ['javax/microedition/io/Connection'],
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

export const mediaNatives: NativeClassDef[] = [
  mediaException,
  playerListener,
  controlClass,
  controllableClass,
  volumeControlInterface,
  volumeControlImpl,
  inputConnectionClass,
  connectionClass,
  playerClass,
  managerClass,
  toneSequence,
  tonePlayerClass,
  midiDevice,
];
