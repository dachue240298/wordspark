// Sound effects using Web Audio API (no files needed)
// iOS Safari requires AudioContext to be created/resumed after user gesture
let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // iOS: always try to resume — context can re-suspend after idle
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Unlock audio on first user touch (required for iOS)
export function unlock() {
  const ctx = getCtx();
  if (ctx.state === 'suspended') {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    ctx.resume();
  }
}

// Auto-unlock on user touch/click (persistent — iOS re-suspends after idle)
if (typeof document !== 'undefined') {
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('click', unlock);
}

// ✅ Correct answer: cheerful "ting ting" (2 soft chimes)
export function playCorrect() {
  try {
    const ctx = getCtx();
    const now = ctx.currentTime;

    // Chime 1
    playTone(ctx, 880, now, 0.15, 0.55, 'sine');      // A5
    // Chime 2 (higher, delayed)
    playTone(ctx, 1318.5, now + 0.12, 0.15, 0.5, 'sine'); // E6
  } catch (e) { /* silent fail */ }
}

// ❌ Wrong answer: soft low buzz
export function playWrong() {
  try {
    const ctx = getCtx();
    const now = ctx.currentTime;

    playTone(ctx, 220, now, 0.3, 0.45, 'triangle');    // A3 low
    playTone(ctx, 185, now + 0.08, 0.25, 0.4, 'triangle'); // slight dissonance
  } catch (e) { /* silent fail */ }
}

// 🏆 Topic complete / great result: ascending arpeggio
export function playSuccess() {
  try {
    const ctx = getCtx();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6

    notes.forEach((freq, i) => {
      playTone(ctx, freq, now + i * 0.1, 0.18, 0.5, 'sine');
    });
  } catch (e) { /* silent fail */ }
}

// ⏰ Time almost up: quick tick
export function playTick() {
  try {
    const ctx = getCtx();
    playTone(ctx, 600, ctx.currentTime, 0.06, 0.3, 'square');
  } catch (e) { /* silent fail */ }
}

function playTone(ctx, freq, startTime, duration, volume, type) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.01);
}
