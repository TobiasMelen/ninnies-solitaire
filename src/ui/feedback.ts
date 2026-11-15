import { settings } from './settings';

// Everything is synthesised with WebAudio so there are no audio assets to load.
let ctx: AudioContext | null = null;
let out: AudioNode | null = null;
let noise: AudioBuffer | null = null;

export function unlockAudio() {
  if (!settings.sound) return;
  try {
    // Without this, iOS mutes web audio whenever the ringer switch is on silent.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
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
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
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

/** A card settling on the table. */
const land = (when = 0, gain = 1) => {
  tap(1400, 0.07, 0.12 * gain, when);
  thump(0.14 * gain, when);
};

export const sfx = {
  /** Lifting a card off the pile. */
  pick: () => {
    swoosh(0.1, 0.06, 0, 900, 500);
  },
  /** Dropped where the finger let go: barely any travel, just the landing. */
  drop: () => land(0.02),
  /** Card sweeping across the table, landing when the animation does. */
  move: (cards = 1) => {
    swoosh(0.24, 0.11);
    land(0.24, Math.min(1.25, 0.9 + cards * 0.04));
  },
  /** A face-down card turning over: a soft double flick. */
  flip: (when = 0) => {
    tap(2000, 0.04, 0.06, when);
    tap(1500, 0.05, 0.05, when + 0.045);
  },
  /** One card flying off the stock. */
  deal: (when = 0) => {
    swoosh(0.18, 0.07, when, 500, 1500);
    tap(1200, 0.05, 0.05, when + 0.16);
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
  complete: () => {
    for (let i = 0; i < 5; i++) swoosh(0.16, 0.04, i * 0.07, 600, 1600);
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.6, 0.045, 0.28 + i * 0.09));
  },
  win: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.8, 0.05, i * 0.13)),
  undo: () => {
    swoosh(0.2, 0.08, 0, 1200, 500);
    land(0.2, 0.6);
  },
};

export function haptic(pattern: number | number[] = 8) {
  if (settings.haptics && 'vibrate' in navigator) navigator.vibrate(pattern);
}

export const canVibrate = () => 'vibrate' in navigator;
