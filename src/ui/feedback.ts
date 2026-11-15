import { settings } from './settings';

// Everything is synthesised with WebAudio so there are no audio assets to load.
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

export function unlockAudio() {
  if (!settings.sound) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    if (!noise) {
      noise = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
  } catch {
    ctx = null;
  }
}

function ready(): AudioContext | null {
  if (!settings.sound) return null;
  unlockAudio();
  return ctx && ctx.state === 'running' ? ctx : null;
}

/** Short filtered noise burst: the "snap" of a card on felt. */
function snap(freq: number, dur: number, gain: number, when = 0) {
  const a = ready();
  if (!a || !noise) return;
  const t = a.currentTime + when;
  const src = a.createBufferSource();
  src.buffer = noise;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter).connect(g).connect(a.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function tone(freq: number, dur: number, gain: number, when = 0, type: OscillatorType = 'sine') {
  const a = ready();
  if (!a) return;
  const t = a.currentTime + when;
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  pick: () => snap(2600, 0.05, 0.12),
  place: () => snap(1500, 0.08, 0.35),
  flip: (when = 0) => snap(3400, 0.04, 0.12, when),
  deal: (when = 0) => snap(2000, 0.05, 0.16, when),
  invalid: () => {
    tone(140, 0.14, 0.18, 0, 'triangle');
    tone(110, 0.16, 0.14, 0.07, 'triangle');
  },
  complete: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 0.09, i * 0.07)),
  win: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.45, 0.1, i * 0.11, 'triangle')),
  undo: () => snap(1100, 0.06, 0.18),
};

export function haptic(pattern: number | number[] = 8) {
  if (settings.haptics && 'vibrate' in navigator) navigator.vibrate(pattern);
}

export const canVibrate = () => 'vibrate' in navigator;
