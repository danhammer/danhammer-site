// Tiny tween scheduler driven by the render loop. Every tween belongs to a "run";
// cancelling a run resolves its pending tweens with false so sequences can stop cleanly.

const tweens = new Set();

export const ease = {
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outBack: (t) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};

// tween(duration ms, fn(eased t, raw t), {delay, easing, run}) -> Promise<boolean finished>
export function tween(duration, fn, { delay = 0, easing = ease.inOutCubic, run = 0 } = {}) {
  return new Promise((resolve) => {
    tweens.add({ start: performance.now() + delay, duration, fn, easing, run, resolve, started: false });
  });
}

export function tick(now) {
  for (const tw of tweens) {
    if (now < tw.start) continue;
    const raw = Math.min(1, (now - tw.start) / Math.max(1, tw.duration));
    tw.fn(tw.easing(raw), raw);
    if (raw >= 1) { tweens.delete(tw); tw.resolve(true); }
  }
}

// Cancel every tween that belongs to a run other than `keep` (run 0 = untracked, never cancelled).
export function cancelExcept(keep) {
  for (const tw of tweens) {
    if (tw.run !== 0 && tw.run !== keep) { tweens.delete(tw); tw.resolve(false); }
  }
}
