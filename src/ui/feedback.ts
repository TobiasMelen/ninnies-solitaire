import cardTakeUrl from '../assets/sounds/card-take.mp3?url';
import { onSettings, settings } from './settings';

// Everything is synthesised with WebAudio so there are no audio assets to load.
let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let noise: AudioBuffer | null = null;
/** Recorded card slide (see assets/sounds/CREDITS.txt); synthesised fallback until it's decoded. */
let cardTake: AudioBuffer | null = null;
let cardTakeLoading = false;

export function unlockAudio() {
  if (!settings.sound) return;
  try {
    // 'ambient' = short game sounds: mixes with the player's music and never puts media
    // controls on the lock screen ('playback' did). Like most games, it follows the silent switch.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'ambient') session.type = 'ambient';
    if (!ctx) {
      ctx = new AudioContext();
      // A gentle compressor glues the layered sounds together and keeps stacked deals from clipping.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      const master = ctx.createGain();
      master.gain.value = 0.6;
      // Roll off the top end so nothing ever sounds clicky or shrill.
      const warm = ctx.createBiquadFilter();
      warm.type = 'lowpass';
      warm.frequency.value = 2600;
      warm.Q.value = 0.5;
      master.connect(warm).connect(comp).connect(ctx.destination);
      out = master;
      const a = ctx;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) void a.suspend();
        else if (settings.sound) void a.resume();
      });
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (!cardTakeLoading) {
      cardTakeLoading = true;
      const a = ctx;
      fetch(cardTakeUrl)
        .then((r) => r.arrayBuffer())
        .then((buf) => a.decodeAudioData(buf))
        .then((b) => (cardTake = b))
        .catch(() => (cardTakeLoading = false));
    }
    // iOS uses 'interrupted' as well as 'suspended', and only unlocks once something is
    // played inside a gesture it trusts (touchend/click, not touch pointerdown), so keep trying.
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start();
    }
  } catch {
    ctx = null;
  }
}

// With sound off, pause the engine entirely (including the keep-alive) to save battery.
onSettings((s) => {
  if (!s.sound && ctx && ctx.state === 'running') void ctx.suspend();
});

export const audioState = () => ctx?.state ?? 'none';

function ready(): AudioContext | null {
  if (!settings.sound) return null;
  unlockAudio();
  return ctx && ctx.state === 'running' ? ctx : null;
}

function noiseSource(a: AudioContext) {
  const src = a.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  return src;
}

/** Soft low-passed noise tap: a card edge touching the table. */
function tap(freq: number, dur: number, gain: number, when = 0) {
  const a = ready();
  if (!a || !noise || !out) return;
  const t = a.currentTime + when;
  const src = noiseSource(a);
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = freq;
  filter.Q.value = 0.3;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

/** Card sliding over felt: a sweeping band of noise with its top end cut off and soft fades. */
function swoosh(dur: number, gain: number, when = 0, from = 450, to = 1300) {
  const a = ready();
  if (!a || !noise || !out) return;
  const t = a.currentTime + when;
  const src = noiseSource(a);
  const band = a.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.55;
  band.frequency.setValueAtTime(from, t);
  band.frequency.exponentialRampToValueAtTime(to, t + dur);
  const high = a.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 180;
  const top = a.createBiquadFilter();
  top.type = 'lowpass';
  top.frequency.value = 1700;
  top.Q.value = 0.4;
  const g = a.createGain();
  const peak = t + dur * 0.45;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, peak);
  g.gain.setTargetAtTime(0, peak, dur * 0.22);
  src.connect(band).connect(high).connect(top).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur * 1.8);
}

/** Low, soft body of a card settling on felt. */
function thump(gain: number, when = 0) {
  const a = ready();
  if (!a || !out) return;
  const t = a.currentTime + when;
  const osc = a.createOscillator();
  osc.frequency.setValueAtTime(130, t);
  osc.frequency.exponentialRampToValueAtTime(65, t + 0.08);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.13);
}

function tone(freq: number, dur: number, gain: number, when = 0) {
  const a = ready();
  if (!a || !out) return;
  const t = a.currentTime + when;
  const osc = a.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** The recording starts with ~180 ms of near-silence; skip it so the sound is instant. */
const TAKE_OFFSET = 0.18;

/** Play the recorded card slide with a little random pitch so repeats don't sound identical. */
function sample(gain: number, when = 0, rate = 1, opts: { length?: number; lowpass?: number } = {}): boolean {
  const a = ready();
  if (!a || !out || !cardTake) return false;
  const t = a.currentTime + when;
  const src = a.createBufferSource();
  src.buffer = cardTake;
  src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
  const g = a.createGain();
  // A few ms fade-in so starting mid-recording never clicks.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  if (opts.length) {
    g.gain.setValueAtTime(gain, t + opts.length * 0.6);
    g.gain.linearRampToValueAtTime(0, t + opts.length);
  }
  let node: AudioNode = src;
  if (opts.lowpass) {
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lowpass;
    lp.Q.value = 0.3;
    node = node.connect(lp);
  }
  node.connect(g).connect(out);
  src.start(t, TAKE_OFFSET, opts.length);
  return true;
}

/** Bell: a sine with two quieter overtones that decay faster, so it rings rather than beeps. */
function bell(freq: number, dur: number, gain: number, when = 0) {
  tone(freq, dur, gain, when);
  tone(freq * 2, dur * 0.6, gain * 0.35, when);
  tone(freq * 3, dur * 0.35, gain * 0.12, when);
}

/** Soft brass: two detuned saws through a low-pass that opens on the attack. */
function brass(freq: number, dur: number, gain: number, when = 0) {
  const a = ready();
  if (!a || !out) return;
  const t = a.currentTime + when;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(400, t);
  filter.frequency.linearRampToValueAtTime(1800, t + 0.06);
  filter.frequency.exponentialRampToValueAtTime(900, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.04);
  g.gain.setValueAtTime(gain * 0.8, t + Math.max(0.05, dur - 0.12));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
  filter.connect(g).connect(out);
  for (const detune of [-7, 7]) {
    const osc = a.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + dur + 0.3);
  }
}

/** A card settling on the table. */
const land = (when = 0, gain = 1) => {
  tap(1400, 0.07, 0.12 * gain, when);
  thump(0.14 * gain, when);
};

export const sfx = {
  /** Lifting a card off the pile. */
  pick: () => {
    // Just the start of the slide, before the snap: a card leaving the pile.
    if (!sample(0.45, 0, 0.95, { length: 0.14, lowpass: 2200 })) swoosh(0.1, 0.06, 0, 900, 500);
  },
  /** Dropped where the finger let go: barely any travel, just the landing. */
  drop: () => land(0.02),
  /** Card sweeping across the table, landing when the animation does. */
  /** `landAt`: seconds until the card visibly arrives, so the landing lines up with the animation. */
  move: (cards = 1, landAt = 0.18) => {
    // Same recording as the deal (that one sounds right), then a soft version of the drop.
    if (!sample(0.42, 0, 1, { lowpass: 1900 })) swoosh(landAt, 0.08);
    land(landAt, Math.min(0.7, 0.45 + cards * 0.03));
  },
  /** A face-down card turning over: a soft double flick. */
  flip: (when = 0) => {
    tap(2000, 0.04, 0.06, when);
    tap(1500, 0.05, 0.05, when + 0.045);
  },
  /** One card flying off the stock. */
  deal: (when = 0) => {
    if (!sample(0.8, when, 1.1)) {
      swoosh(0.18, 0.07, when, 500, 1500);
      tap(1200, 0.05, 0.05, when + 0.16);
    }
  },
  /** Shuffle-in at the start of a game. */
  shuffle: () => {
    for (let i = 0; i < 12; i++) tap(1200 + Math.random() * 600, 0.035, 0.04, i * 0.03);
  },
  /** A muted "nope". */
  invalid: () => {
    tone(196, 0.16, 0.07);
    tone(165, 0.2, 0.06, 0.08);
  },
  /** A finished K→A stack: the cards whoosh off, then a bright rising bell arpeggio. */
  complete: () => {
    for (let i = 0; i < 5; i++) swoosh(0.16, 0.06, i * 0.06, 600, 1600);
    thump(0.16, 0.25);
    [523, 659, 784, 1047].forEach((f, i) => bell(f, i === 3 ? 1.4 : 0.7, 0.11, 0.25 + i * 0.085));
    bell(1319, 1.2, 0.05, 0.25 + 4 * 0.085);
  },
  /** Winning the game: a short fanfare ending on a held major chord, with sparkles on top. */
  win: () => {
    const beat = 0.15;
    const notes: [number, number, number][] = [
      [523, 0, 0.12],
      [523, 1, 0.12],
      [523, 2, 0.12],
      [659, 3, 0.42],
      [587, 6, 0.12],
      [659, 7, 0.12],
    ];
    notes.forEach(([f, at, dur]) => brass(f, dur, 0.07, at * beat));
    const end = 8 * beat;
    for (const f of [262, 523, 659, 784]) brass(f, 1.5, 0.055, end);
    thump(0.22, 0);
    thump(0.25, end);
    [1047, 1319, 1568, 2093].forEach((f, i) => bell(f, 1.1, 0.035, end + 0.1 + i * 0.09));
  },
  undo: () => {
    swoosh(0.2, 0.08, 0, 1200, 500);
    land(0.2, 0.6);
  },
};

export function haptic(pattern: number | number[] = 8) {
  if (settings.haptics && 'vibrate' in navigator) navigator.vibrate(pattern);
}

export const canVibrate = () => 'vibrate' in navigator;
