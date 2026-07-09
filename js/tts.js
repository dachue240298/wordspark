// Web Speech API TTS for WordSpark PWA
let speaking = false;

export function isSupported() {
  return 'speechSynthesis' in window;
}

function speak(text, lang = 'en-US', rate = 0.9) {
  return new Promise((resolve) => {
    if (!isSupported()) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    u.pitch = 1;
    u.volume = 1;
    u.onend = () => { speaking = false; resolve(); };
    u.onerror = () => { speaking = false; resolve(); };
    speaking = true;
    speechSynthesis.speak(u);
  });
}

export function speakEN(text) { return speak(text, 'en-US', 0.85); }
export function speakVI(text) { return speak(text, 'vi-VN', 0.9); }
export function speakZH(text) { return speak(text, 'zh-CN', 0.8); }

export async function speakWord(word, meaningVi, mode) {
  speechSynthesis.cancel();
  if (mode === 'silent') return;
  if (mode === 'en') { await speakEN(word); return; }
  if (mode === 'en_vi') {
    await speakEN(word);
    await new Promise(r => setTimeout(r, 1000));
    await speakVI(meaningVi);
  }
}

export function stop() { speechSynthesis.cancel(); speaking = false; }
export function isSpeaking() { return speaking; }
