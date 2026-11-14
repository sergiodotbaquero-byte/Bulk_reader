import { getSettings } from './settings';

let ctx: AudioContext | null = null;

/** Debe llamarse desde un gesto del usuario (iOS no deja crear audio de otra forma). */
export function primeAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function beep(kind: 'ok' | 'error' = 'ok'): void {
  if (!getSettings().sound) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = kind === 'ok' ? 1046 : 220;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'ok' ? 0.12 : 0.28));
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.32);
  } catch {
    // sin audio
  }
}

export function vibrate(pattern: number | number[] = 40): void {
  if (!getSettings().vibrate) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // sin vibración
  }
}

export function feedbackAdded(): void {
  beep('ok');
  vibrate(40);
}

export function feedbackError(): void {
  beep('error');
  vibrate([60, 40, 60]);
}
