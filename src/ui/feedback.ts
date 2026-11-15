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
      master.gain.value = 0.9;
      master.connect(comp).connect(ctx.destination);
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

/** Short filtered noise burst: the "snap" of a card edge. */
function snap(freq: number, dur: number, gain: number, when = 0) {
  const a = ready();
  if (!a || !noise || !out) return;
  const t = a.currentTime + when;
  const src = noiseSource(a);
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.1;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

/** Card sliding over felt: noise through a sweeping band-pass with a soft swell. */
function swoosh(dur: number, gain: number, when = 0, from = 700, to = 2600) {
  const a = ready();
  if (!a || !noise || !out) return;
  const t = a.currentTime + when;
  const src = noiseSource(a);
  const band = a.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.9;
  band.frequency.setValueAtTime(from, t);
  band.frequency.exponentialRampToValueAtTime(to, t + dur);
  const high = a.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 350;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(band).connect(high).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

/** Low body of a card landing on the table. */
function thump(gain: number, when = 0) {
  const a = ready();
  if (!a || !out) return;
  const t = a.currentTime + when;
  const osc = a.createOscillator();
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.07);
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.1);
}

function tone(freq: number, dur: number, gain: number, when = 0, type: OscillatorType = 'sine') {
  const a = ready();
  if (!a || !out) return;
  const t = a.currentTime + when;
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A card hitting the table: snap + body. */
const land = (when = 0, gain = 1) => {
  snap(1700, 0.06, 0.32 * gain, when);
  thump(0.22 * gain, when);
};

export const sfx = {
  /** Lifting a card off the pile. */
  pick: () => swoosh(0.09, 0.1, 0, 2200, 1200),
  /** Dropped where the finger let go: barely any travel, just the landing. */
  drop: () => land(0.02),
  /** Card sweeping across the table, landing when the animation does. */
  move: (cards = 1) => {
    swoosh(0.22, 0.2);
    land(0.24, Math.min(1.3, 0.9 + cards * 0.05));
  },
  /** A face-down card turning over: two quick paper flicks. */
  flip: (when = 0) => {
    snap(3600, 0.035, 0.16, when);
    snap(2400, 0.05, 0.12, when + 0.04);
  },
  /** One card flying off the stock. */
  deal: (when = 0) => {
    swoosh(0.16, 0.13, when, 900, 3000);
    snap(2000, 0.04, 0.12, when + 0.15);
  },
  /** Shuffle-in at the start of a game. */
  shuffle: () => {
    for (let i = 0; i < 14; i++) snap(1800 + Math.random() * 1600, 0.03, 0.08, i * 0.028);
  },
  invalid: () => {
    tone(140, 0.14, 0.18, 0, 'triangle');
    tone(110, 0.16, 0.14, 0.07, 'triangle');
  },
  complete: () => {
    for (let i = 0; i < 6; i++) swoosh(0.14, 0.07, i * 0.06, 1200, 3200);
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 0.09, 0.25 + i * 0.07));
  },
  win: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.45, 0.1, i * 0.11, 'triangle')),
  undo: () => {
    swoosh(0.18, 0.14, 0, 2600, 900);
    land(0.2, 0.7);
  },
};

export function haptic(pattern: number | number[] = 8) {
  if (settings.haptics && 'vibrate' in navigator) navigator.vibrate(pattern);
}

export const canVibrate = () => 'vibrate' in navigator;
