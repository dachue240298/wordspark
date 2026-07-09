import * as DB from './db.js';
import * as TTS from './tts.js';
import * as SFX from './sfx.js';
import { WORDS, TOPICS } from './seed-data.js';

const POS_VI = {noun:'danh từ',verb:'động từ',adj:'tính từ',adv:'trạng từ',prep:'giới từ',conj:'liên từ',intj:'thán từ',pron:'đại từ',det:'mạo từ'};
const STATUS_VI = {new:'Mới',learning:'Đang học',review:'Ôn tập',mastered:'Đã thuộc'};
const STATUS_CLR = {mastered:'var(--secondary)',learning:'var(--primary)',review:'var(--warning)'};
const today = () => new Date().toISOString().split('T')[0];

let currentWordId = null;
let notifTimer = null;
let dailyWordsList = [];
let currentLang = 'en'; // Active language ('en' or 'zh')

// ─── INIT ──────────────────────────────────────────────
const SEED_VERSION = '1050v1'; // 750 EN + 300 ZH words
async function init() {
  await DB.openDB();
  await DB.initSettings();

  // Check if words need (re)seeding
  const savedVer = await DB.getSetting('seed_version');
  if (savedVer !== SEED_VERSION) {
    // Clear old words and reseed all
    await DB.clearWords();
    await DB.addWords(WORDS);
    for (let i = 1; i <= WORDS.length; i++) await DB.initProgress(i);
    await DB.setSetting('seed_version', SEED_VERSION);
    console.log(`[WordSpark] Seeded ${WORDS.length} words (v${SEED_VERSION})`);
  }

  updateGreeting();

  // Load active language — show picker if not chosen yet
  const savedLang = await DB.getLanguage();
  if (!savedLang) {
    // First launch: show language picker
    document.getElementById('tab-bar').style.display = 'none';
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('lang-picker').classList.add('active');
    setupLangPicker();
    return; // Don't load anything else until language is chosen
  }
  currentLang = savedLang;

  await loadDailyWords();
  await loadStats();

  // Auto-freeze: protect streak if yesterday was missed
  const frozeYesterday = await DB.autoFreezeYesterday();
  if (frozeYesterday) {
    const remaining = await DB.getStreakFreezeRemaining();
    showFreezeToast(remaining);
    await loadStats(); // Refresh stats with updated streak
  }

  setupNotifications();
  setupListeners();
  // Force SW update
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.update()));
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}

// ─── LANGUAGE PICKER ───────────────────────────────────
function setupLangPicker() {
  document.querySelectorAll('.lang-card').forEach(card => {
    card.addEventListener('click', async () => {
      const lang = card.dataset.lang;
      await DB.setLanguage(lang);
      // Reload app with chosen language
      location.reload();
    });
  });
}

// ─── GREETING ──────────────────────────────────────────
function updateGreeting() {
  const h = new Date().getHours();
  const g = h < 12 ? '🌅 Good morning!' : h < 18 ? '☀️ Good afternoon!' : '🌙 Good evening!';
  document.getElementById('greeting').textContent = g;
}

// ─── DAILY WORDS ───────────────────────────────────────
async function loadDailyWords() {
  const countStr = await DB.getSetting('daily_word_count');
  const count = parseInt(countStr) || 10;
  dailyWordsList = await DB.generateDailyWords(today(), count, currentLang);

  const list = document.getElementById('word-list');
  list.innerHTML = '';
  let learnedCount = 0;

  for (let i = 0; i < dailyWordsList.length; i++) {
    const dw = dailyWordsList[i];
    const word = await DB.getWord(dw.wordId);
    if (!word) continue;
    if (dw.isLearned) learnedCount++;

    const card = document.createElement('div');
    card.className = `word-card${dw.isLearned ? ' learned' : ''}`;
    const isZH = word.lang === 'zh';
    card.innerHTML = `
      <div class="word-num">${dw.isLearned ? '✓' : i + 1}</div>
      <div class="word-info">
        <div class="word-top">
          <span class="word-en" ${isZH ? 'style="font-size:22px"' : ''}>${word.word}</span>
          ${isZH ? (word.pinyin ? `<span class="word-ipa">${word.pinyin}</span>` : '') : (word.ipa ? `<span class="word-ipa">${word.ipa}</span>` : '')}
        </div>
        ${dw.isLearned ? `<div class="word-vi">${word.vi}</div>` : `<div class="word-vi word-vi-hidden">Bấm để đoán nghĩa...</div>`}
      </div>
      ${word.pos ? `<span class="word-pos">${POS_VI[word.pos] || word.pos}</span>` : ''}
      <span class="word-arrow">›</span>
    `;
    card.addEventListener('click', () => openDetail(dw.wordId, dw.id));
    list.appendChild(card);
  }

  document.getElementById('progress-badge').textContent = `${learnedCount}/${dailyWordsList.length}`;

  // Daily words action buttons
  let actionsDiv = document.getElementById('daily-actions');
  if (!actionsDiv) {
    actionsDiv = document.createElement('div');
    actionsDiv.id = 'daily-actions';
    actionsDiv.className = 'daily-actions';
    list.parentElement.insertBefore(actionsDiv, list.nextSibling);
  }

  if (learnedCount >= dailyWordsList.length && dailyWordsList.length > 0) {
    actionsDiv.innerHTML = `
      <button class="daily-action-btn review" id="btn-daily-review">🔄 Ôn lại ${dailyWordsList.length} từ</button>
      <button class="daily-action-btn new" id="btn-daily-new">📖 Đổi 10 từ mới</button>
    `;
    document.getElementById('btn-daily-review').addEventListener('click', async () => {
      // Reset learned status → re-quiz same words
      for (const dw of dailyWordsList) await DB.markDailyWord(dw.id, false);
      await loadDailyWords();
    });
    document.getElementById('btn-daily-new').addEventListener('click', async () => {
      // Generate fresh batch avoiding already-done words
      const existingIds = dailyWordsList.map(dw => dw.wordId);
      const allIds = await DB.getAllWordIds();
      const available = allIds.filter(id => !existingIds.includes(id));
      if (available.length < 5) { actionsDiv.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:12px">Hết từ mới! Hãy thử chủ đề khác 📚</div>'; return; }
      const shuffled = available.sort(() => Math.random() - 0.5).slice(0, 10);
      const db = await DB.openDB();
      const t = db.transaction('dailyWords', 'readwrite');
      const s = t.objectStore('dailyWords');
      for (const wordId of shuffled) s.add({ wordId, date: today(), shownCount: 0, isLearned: false });
      await new Promise((ok, no) => { t.oncomplete = ok; t.onerror = no; });
      dailyWordsList = await DB.getDailyWords(today());
      await loadDailyWords();
    });
  } else {
    actionsDiv.innerHTML = '';
  }
}




// ─── DETAIL SCREEN (Quiz Mode) ─────────────────────────
let currentDailyId = null;

// Get 3 wrong answers: prioritize same topic → same POS → random
function getWrongChoices(correctVi, count = 3, word = null) {
  // Filter by same language to avoid cross-language wrong answers
  let pool = WORDS.filter(w => w.vi !== correctVi && (w.lang || 'en') === currentLang);
  if (word) {
    const sameTopic = pool.filter(w => w.topic === word.topic).sort(() => Math.random() - 0.5);
    const samePOS = pool.filter(w => w.pos === word.pos && w.topic !== word.topic).sort(() => Math.random() - 0.5);
    const rest = pool.filter(w => w.topic !== word.topic && w.pos !== word.pos).sort(() => Math.random() - 0.5);
    pool = [...sameTopic, ...samePOS, ...rest];
  } else {
    pool = pool.sort(() => Math.random() - 0.5);
  }
  return pool.slice(0, count).map(w => w.vi);
}

// Get wrong pinyin choices for L4 quiz
function getWrongPinyin(correctPinyin, count = 3, word = null) {
  let pool = WORDS.filter(w => w.pinyin && w.pinyin !== correctPinyin && w.lang === 'zh');
  if (word) {
    const sameTopic = pool.filter(w => w.topic === word.topic).sort(() => Math.random() - 0.5);
    const rest = pool.filter(w => w.topic !== word.topic).sort(() => Math.random() - 0.5);
    pool = [...sameTopic, ...rest];
  } else {
    pool = pool.sort(() => Math.random() - 0.5);
  }
  return pool.slice(0, count).map(w => w.pinyin);
}

async function openDetail(wordId, dailyId) {
  currentWordId = wordId;
  currentDailyId = dailyId;
  const word = await DB.getWord(wordId);
  const prog = await DB.getProgress(wordId) || { status: 'new', timesCorrect: 0, timesWrong: 0 };
  const isZH = word.lang === 'zh';

  const statusColor = STATUS_CLR[prog.status] || 'var(--text-muted)';
  document.getElementById('detail-status').textContent = STATUS_VI[prog.status] || 'Mới';
  document.getElementById('detail-status').style.cssText = `color:${statusColor};background:${statusColor}22`;

  // Build 4 choices (1 correct + 3 wrong), shuffled
  const wrongChoices = getWrongChoices(word.vi, 3, word);
  const choices = [word.vi, ...wrongChoices].sort(() => Math.random() - 0.5);

  // Expose speak functions
  if (isZH) {
    window._speakEN = () => TTS.speakZH(word.word);
    window._speakVI = () => TTS.speakVI(word.vi);
    window._speakBoth = () => { TTS.speakZH(word.word); setTimeout(() => TTS.speakVI(word.vi), 1500); };
  } else {
    window._speakEN = () => TTS.speakEN(word.word);
    window._speakVI = () => TTS.speakVI(word.vi);
    window._speakBoth = () => TTS.speakWord(word.word, word.vi, 'en_vi');
  }

  // Detail body — adapt for Chinese vs English
  const headerHTML = isZH ? `
    <div class="text-center">
      <div class="detail-word" style="font-size:48px">${word.word}</div>
      <div class="detail-ipa">${word.pinyin || ''}</div>
      ${word.pos ? `<div class="text-center"><span class="detail-pos-tag">${POS_VI[word.pos] || word.pos}</span></div>` : ''}
      <div style="display:flex;justify-content:center;gap:16px;margin-top:8px;font-size:13px;color:var(--text-muted)">
        ${word.radical ? `<span>部首 ${word.radical}</span>` : ''}
        ${word.strokes ? `<span>${word.strokes} 画</span>` : ''}
      </div>
    </div>` : `
    <div class="text-center">
      <div class="detail-word">${word.word}</div>
      ${word.ipa ? `<div class="detail-ipa">${word.ipa}</div>` : ''}
      ${word.pos ? `<div class="text-center"><span class="detail-pos-tag">${POS_VI[word.pos] || word.pos}</span></div>` : ''}
    </div>`;

  document.getElementById('detail-body').innerHTML = `
    ${headerHTML}
    <div class="speak-row">
      <button class="speak-btn" onclick="window._speakEN()">${isZH ? '🔊 Nghe đọc' : '🔊 Nghe phát âm'}</button>
    </div>
    <div class="quiz-prompt">Chọn nghĩa đúng:</div>
    <div class="quiz-options" id="quiz-options">
      ${choices.map((c, i) => `<button class="quiz-option" data-answer="${c}">${String.fromCharCode(65 + i)}. ${c}</button>`).join('')}
    </div>
    <div style="height:100px"></div>
  `;

  document.getElementById('detail-actions').style.display = 'none';

  document.querySelectorAll('.quiz-option').forEach(btn => {
    btn.addEventListener('click', () => revealAnswer(word, prog, btn.dataset.answer));
  });

  showScreen('detail-screen');
}

function revealAnswer(word, prog, selected) {
  const isCorrect = selected === word.vi;

  // Highlight choices
  document.querySelectorAll('.quiz-option').forEach(btn => {
    btn.disabled = true;
    btn.classList.add('quiz-disabled');
    if (btn.dataset.answer === word.vi) {
      btn.classList.add('quiz-correct');
    } else if (btn.dataset.answer === selected && !isCorrect) {
      btn.classList.add('quiz-wrong');
    }
  });

  // Show result banner
  const resultHTML = isCorrect
    ? `<div class="quiz-result quiz-result-correct">✅ Chính xác!</div>`
    : `<div class="quiz-result quiz-result-wrong">❌ Sai rồi! Đáp án đúng: <strong>${word.vi}</strong></div>`;

  // Show full explanation below
  const isZH = word.lang === 'zh';
  const explanationHTML = `
    ${resultHTML}
    <div class="info-card" style="margin-top:16px">
      <div class="info-card-title"><span>📝</span> Nghĩa</div>
      <div class="meaning-vi">${word.vi}</div>
      ${isZH ? (word.zh ? `<div class="meaning-en">${word.zh}</div>` : '') : (word.en ? `<div class="meaning-en">${word.en}</div>` : '')}
    </div>
    ${(isZH ? word.ex_zh : word.ex_en) ? `
    <div class="info-card">
      <div class="info-card-title"><span>💬</span> Ví dụ</div>
      <div class="example-en">${isZH ? word.ex_zh : word.ex_en}</div>
      ${word.ex_vi ? `<div class="example-vi">${word.ex_vi}</div>` : ''}
    </div>` : ''}
    <div class="speak-row" style="margin-top:14px">
      <button class="speak-btn" onclick="window._speakEN()">${isZH ? '🇨🇳 ZH' : '🇺🇸 EN'}</button>
      <button class="speak-btn" onclick="window._speakVI()">🇻🇳 VI</button>
      <button class="speak-btn" onclick="window._speakBoth()">${isZH ? '🔊 ZH+VI' : '🔊 EN+VI'}</button>
    </div>
    <div class="info-card">
      <div class="info-card-title"><span>📊</span> Tiến độ</div>
      <div class="progress-row">
        <div class="progress-stat"><div class="progress-stat-emoji">✅</div><div class="progress-stat-value">${prog.timesCorrect + (isCorrect ? 1 : 0)}</div><div class="progress-stat-label">Đúng</div></div>
        <div class="progress-stat"><div class="progress-stat-emoji">❌</div><div class="progress-stat-value">${prog.timesWrong + (isCorrect ? 0 : 1)}</div><div class="progress-stat-label">Sai</div></div>
      </div>
    </div>
    <button class="btn-ai-explain" id="btn-ai-explain">🤖 AI Giải thích</button>
    <div id="ai-explain-result" class="ai-explain-result"></div>
    <div style="height:100px"></div>
  `;

  // Append explanation after quiz options
  const container = document.getElementById('detail-body');
  const explDiv = document.createElement('div');
  explDiv.className = 'reveal-section';
  explDiv.innerHTML = explanationHTML;
  container.appendChild(explDiv);

  // Scroll to result
  explDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Show bottom action buttons
  document.getElementById('detail-actions').style.display = 'flex';

  // Sound effects + TTS
  if (isCorrect) { SFX.playCorrect(); TTS.speakEN(word.word); }
  else { SFX.playWrong(); }

  // AI Explain button
  setTimeout(() => {
    const aiBtn = document.getElementById('btn-ai-explain');
    if (aiBtn) {
      aiBtn.addEventListener('click', async () => {
        aiBtn.disabled = true;
        aiBtn.textContent = '⏳ Đang hỏi AI...';
        const result = await askGemini(word);
        const resBox = document.getElementById('ai-explain-result');
        if (result) {
          // Basic markdown to HTML
          const html = result
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
          resBox.innerHTML = `<div class="ai-explain-content">${html}</div>`;
        } else {
          resBox.innerHTML = `<div class="ai-explain-content" style="color:var(--text-muted)">⚠️ Chưa có API key. Vào ⚙️ Cài đặt → nhập Gemini API key để dùng tính năng này.</div>`;
        }
        aiBtn.style.display = 'none';
      });
    }
  }, 100);
}

async function markWord(learned) {
  if (!currentWordId) return;

  // Update daily word if opened from home screen
  if (currentDailyId) {
    await DB.markDailyWord(currentDailyId, learned);
  }

  // Always update progress
  await DB.updateProgress(currentWordId, learned);
  if (learned) await DB.incrementStat(today(), 'words_learned');

  // Navigate back to the correct screen
  if (currentDailyId) {
    // Came from Home → go back to home
    showScreen('home-screen');
    await loadDailyWords();
    await loadStats();
  } else {
    // Came from Topic Detail → go back to topics
    showScreen('topics-screen');
    await loadTopics();
  }
}

// ─── SETTINGS SCREEN ───────────────────────────────────
async function openSettings() {
  const enabled = (await DB.getSetting('notification_enabled')) === 'true';
  const interval = await DB.getSetting('notification_interval') || '30';
  const mode = await DB.getSetting('pronunciation_mode') || 'en';
  const intervals = [15, 20, 25, 30, 45, 60];

  document.getElementById('settings-body').innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">🔔 Thông báo</div>
      <div class="settings-card">
        <div class="setting-row">
          <div><div class="setting-label">Bật thông báo từ vựng</div>
          <div class="setting-sub">${enabled ? 'Đang bật' : 'Đã tắt'}</div></div>
          <label class="toggle"><input type="checkbox" id="set-notif" ${enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>
        <div class="interval-chips" id="interval-chips">
          ${intervals.map(m => `<button class="chip${m == interval ? ' active' : ''}" data-val="${m}">${m} phút</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">🔊 Chế độ phát âm</div>
      <div class="settings-card">
        <div class="radio-option${mode==='silent'?' active':''}" data-mode="silent">
          <div class="radio-dot"></div>
          <div><div class="setting-label">🔇 Im lặng</div><div class="setting-sub">Chỉ hiện text</div></div>
        </div>
        <div class="radio-option${mode==='en'?' active':''}" data-mode="en">
          <div class="radio-dot"></div>
          <div><div class="setting-label">🔊 Tự đọc EN</div><div class="setting-sub">Tự phát âm tiếng Anh</div></div>
        </div>
        <div class="radio-option${mode==='en_vi'?' active':''}" data-mode="en_vi">
          <div class="radio-dot"></div>
          <div><div class="setting-label">🔊🔊 Đọc đầy đủ</div><div class="setting-sub">Phát EN → pause → đọc VI</div></div>
        </div>
      </div>
   </div>
    <div class="settings-section">
      <div class="settings-section-title">🌐 Ngôn ngữ đang học</div>
      <div class="settings-card">
        <div class="lang-switch-row" style="padding:14px 16px">
          <button class="lang-switch-btn${currentLang === 'en' ? ' active' : ''}" data-lang="en">
            <span class="lang-switch-icon">🇬🇧</span>Tiếng Anh
          </button>
          <button class="lang-switch-btn${currentLang === 'zh' ? ' active' : ''}" data-lang="zh">
            <span class="lang-switch-icon">🇨🇳</span>Tiếng Trung
          </button>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">ℹ️ Thông tin</div>
      <div class="settings-card">
        <div class="setting-row"><span class="setting-label">Phiên bản</span><span style="color:var(--text-muted)">v0.3.0 PWA</span></div>
        <div class="setting-row"><span class="setting-label">Từ vựng</span><span style="color:var(--text-muted)">${currentLang === 'en' ? '750 từ (A1→B1) • 25 chủ đề' : '300 từ (HSK1) • 10 chủ đề'}</span></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">🤖 AI Assistant (Gemini)</div>
      <div class="settings-card">
        <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="setting-label">API Key (tùy chọn)</div>
          <div class="setting-sub">Nhập Gemini API key để mở khóa tính năng AI giải thích từ vựng</div>
          <input type="password" id="set-gemini-key" placeholder="AIzaSy..." class="quiz-fill-input" style="font-size:13px;max-width:100%;text-align:left;padding:10px 14px">
          <button id="btn-save-gemini-key" class="quiz-fill-submit" style="margin-top:4px;padding:10px;font-size:13px">💾 Lưu API Key</button>
        </div>
      </div>
    </div>
  `;


  // Listeners
  document.getElementById('set-notif').addEventListener('change', async (e) => {
    await DB.setSetting('notification_enabled', e.target.checked ? 'true' : 'false');
    setupNotifications();
  });

  document.getElementById('interval-chips').addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#interval-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    await DB.setSetting('notification_interval', chip.dataset.val);
    setupNotifications();
  });

  document.querySelectorAll('.radio-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      document.querySelectorAll('.radio-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      await DB.setSetting('pronunciation_mode', opt.dataset.mode);
    });
  });

  // Gemini API Key
  const existingKey = await DB.getSetting('gemini_api_key');
  if (existingKey) document.getElementById('set-gemini-key').value = existingKey;
  document.getElementById('btn-save-gemini-key').addEventListener('click', async () => {
    const key = document.getElementById('set-gemini-key').value.trim();
    if (key) {
      await DB.setSetting('gemini_api_key', key);
      const btn = document.getElementById('btn-save-gemini-key');
      btn.textContent = '✅ Đã lưu!';
      setTimeout(() => btn.textContent = '💾 Lưu API Key', 2000);
    }
  });

  // Language switch buttons
  document.querySelectorAll('.lang-switch-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newLang = btn.dataset.lang;
      if (newLang === currentLang) return;
      await DB.setLanguage(newLang);
      location.reload();
    });
  });

  showScreen('settings-screen');
}

// ─── GEMINI AI MODULE ──────────────────────────────────
async function askGemini(word) {
  let key = await DB.getSetting('gemini_api_key');
  if (!key) return null;
  key = key.trim();
  try {
    const isZH = word.lang === 'zh';
    const prompt = isZH
      ? `Giải thích từ tiếng Trung "${word.word}" (${word.pinyin}) - nghĩa: "${word.vi}" cho người Việt học tiếng Trung trình độ HSK1 bằng tiếng Việt. Giải thích ngắn gọn gồm:
1. Bộ thủ và cách nhớ chữ Hán này (2-3 câu)
2. 3 ví dụ câu đơn giản (ZH + Pinyin + VI)
3. Từ liên quan hoặc cùng bộ thủ (nếu có)
Trả lời gọn, dùng emoji cho sinh động.`
      : `Giải thích từ tiếng Anh "${word.word}" (${word.ipa}) - nghĩa: "${word.vi}" cho người học tiếng Anh trình độ A1-A2 bằng tiếng Việt. Giải thích ngắn gọn gồm:
1. Khi nào dùng từ này (2-3 câu)
2. 3 ví dụ câu đơn giản (EN + VI)
3. Từ đồng nghĩa hoặc liên quan (nếu có)
Trả lời gọn, dùng emoji cho sinh động.`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    
    if (!res.ok) {
      console.error('Gemini API HTTP Error:', res.status, await res.text());
      return "⚠️ Lỗi kết nối API. Vui lòng kiểm tra lại API Key hoặc thử lại sau.";
    }

    const data = await res.json();
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    }
    return null;
  } catch (e) {
    console.error('Gemini API error:', e);
    return "⚠️ Có lỗi xảy ra khi gọi AI. Vui lòng thử lại.";
  }
}
// ─── IN-APP NOTIFICATIONS ──────────────────────────────
let lastNotifTime = 0;
async function setupNotifications() {
  if (notifTimer) clearInterval(notifTimer);
  const enabled = (await DB.getSetting('notification_enabled')) === 'true';
  if (!enabled) return;

  const intervalStr = await DB.getSetting('notification_interval') || '30';
  const intervalMs = parseInt(intervalStr) * 60 * 1000;

  notifTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastNotifTime >= intervalMs * 0.9) {
      lastNotifTime = now;
      showNotification();
    }
  }, intervalMs);
}

async function showNotification() {
  if (dailyWordsList.length === 0) return;
  const dw = dailyWordsList[Math.floor(Math.random() * dailyWordsList.length)];
  const word = await DB.getWord(dw.wordId);
  if (!word) return;

  await DB.incrementStat(today(), 'notifications_shown');
  await loadStats();

  // In-app toast
  const toast = document.getElementById('notif-toast');
  document.getElementById('notif-word').textContent = word.word;
  const subText = word.lang === 'zh' ? `${word.vi}  •  ${word.pinyin || ''}` : `${word.vi}  •  ${word.ipa || ''}`;
  document.getElementById('notif-meaning').textContent = subText;
  toast.classList.remove('hidden');

  // TTS — language-aware
  const mode = await DB.getSetting('pronunciation_mode') || 'en';
  if (mode !== 'silent') {
    if (word.lang === 'zh') {
      TTS.speakZH(word.word);
      if (mode === 'en_vi') setTimeout(() => TTS.speakVI(word.vi), 1500);
    } else {
      TTS.speakWord(word.word, word.vi, mode);
    }
  }

  toast.onclick = () => { toast.classList.add('hidden'); openDetail(dw.wordId, dw.id); };
  setTimeout(() => toast.classList.add('hidden'), 6000);

  // Also try browser notification
  if ('Notification' in window && Notification.permission === 'granted') {
    const body = word.lang === 'zh' ? `${word.vi}  •  ${word.pinyin || ''}` : `${word.vi}  •  ${word.ipa || ''}`;
    new Notification(`📖 ${word.word}`, { body, icon: 'icons/icon-192.png' });
  }
}

// ─── REQUEST NOTIFICATION PERMISSION ───────────────────
async function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ─── STREAK FREEZE TOAST ───────────────────────────────
function showFreezeToast(freezeRemaining) {
  const toast = document.getElementById('notif-toast');
  document.getElementById('notif-word').textContent = '❄️ Streak Freeze!';
  document.getElementById('notif-meaning').textContent = `Hôm qua bạn nghỉ — Streak được bảo vệ! (còn ${freezeRemaining} freeze tuần này)`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 5000);
}

// ─── NAVIGATION ────────────────────────────────────────
let activeTab = 'home-screen';

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  // Show/hide tab bar based on screen
  const tabScreens = ['home-screen', 'topics-screen', 'quiz-screen', 'stats-screen'];
  const tabBar = document.getElementById('tab-bar');
  tabBar.style.display = tabScreens.includes(id) ? 'flex' : 'none';
}

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
  showScreen(tabId);
  // Load content on switch
  if (tabId === 'topics-screen') loadTopics();
  if (tabId === 'quiz-screen') loadQuizMenu();
  if (tabId === 'stats-screen') loadDashboard();
}

function setupListeners() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-back').addEventListener('click', () => showScreen(activeTab));
  document.getElementById('btn-settings-back').addEventListener('click', () => { showScreen(activeTab); loadDailyWords(); });
  document.getElementById('btn-review').addEventListener('click', () => markWord(false));
  document.getElementById('btn-learned').addEventListener('click', () => markWord(true));

  // Tab bar
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Topic detail back
  document.getElementById('btn-topic-back').addEventListener('click', () => {
    document.getElementById('topic-detail').classList.add('hidden');
  });

  // Quiz close
  document.getElementById('btn-quiz-close').addEventListener('click', endQuiz);

  // Request notification permission on first interaction
  document.addEventListener('click', () => requestNotifPermission(), { once: true });
}

// ─── TOPICS SCREEN (Phase 3: Learning Path) ───────────
async function loadTopics(filter = '') {
  const grid = document.getElementById('topics-grid');
  grid.innerHTML = '';

  // Add search bar if not exists
  let searchWrap = document.getElementById('topic-search-wrap');
  if (!searchWrap) {
    searchWrap = document.createElement('div');
    searchWrap.id = 'topic-search-wrap';
    searchWrap.className = 'topic-search-wrap';
    searchWrap.innerHTML = '<input type="text" class="topic-search" id="topic-search-input" placeholder="🔍 Tìm chủ đề...">';
    grid.parentElement.insertBefore(searchWrap, grid);
    document.getElementById('topic-search-input').addEventListener('input', (e) => {
      loadTopics(e.target.value.toLowerCase());
    });
  }

  const langFiltered = TOPICS.filter(t => (t.lang || 'en') === currentLang);
  const filtered = filter
    ? langFiltered.filter(t => t.name.toLowerCase().includes(filter) || t.name_vi.toLowerCase().includes(filter))
    : langFiltered;

  for (const topic of filtered) {
    let tp = await DB.getTopicProgress(topic.name);
    if (!tp) tp = await DB.initTopicProgress(topic.name);
    tp = await DB.getTopicProgress(topic.name);
    const learned = tp ? tp.wordsLearned.length : 0;
    const total = topic.count;
    const pct = Math.round((learned / total) * 100);
    const statusLabel = tp?.status === 'mastered' ? '🏆 Hoàn thành' : tp?.status === 'in_progress' ? `📖 ${learned}/${total}` : 'Chưa bắt đầu';
    const statusClass = tp?.status === 'mastered' ? 'mastered' : tp?.status === 'in_progress' ? 'in-progress' : '';
    const levelBadge = topic.level ? ` <span class="topic-level-badge">${topic.level}</span>` : '';

    const card = document.createElement('div');
    card.className = `topic-card ${statusClass}`;
    card.innerHTML = `
      <div class="topic-icon">${topic.icon}</div>
      <div class="topic-name">${topic.name}${levelBadge}</div>
      <div class="topic-name-vi">${topic.name_vi}</div>
      <div class="topic-progress-bar"><div class="topic-progress-fill" style="width:${pct}%"></div></div>
      <div class="topic-status">${statusLabel}</div>
    `;
    card.addEventListener('click', () => openTopicDetail(topic));
    grid.appendChild(card);
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px">Không tìm thấy chủ đề nào 🔍</div>';
  }
}

async function openTopicDetail(topic) {
  document.getElementById('topic-detail-title').textContent = `${topic.icon} ${topic.name_vi}`;
  const list = document.getElementById('topic-word-list');
  list.innerHTML = '';

  const topicWords = await DB.getWordsByTopic(topic.name);
  let tp = await DB.getTopicProgress(topic.name);
  if (!tp) { tp = await DB.initTopicProgress(topic.name); tp = await DB.getTopicProgress(topic.name); }

  const learned = tp ? tp.wordsLearned.length : 0;
  const total = topicWords.length;
  const pct = Math.round((learned / total) * 100);
  const batchNum = tp ? tp.currentBatch : 0;
  const isMastered = tp?.status === 'mastered';
  const canStudyToday = !isMastered && tp?.lastStudyDate !== today();

  // Header with progress
  const header = document.createElement('div');
  header.className = 'topic-detail-progress';
  header.innerHTML = `
    <div class="topic-detail-stats">
      <span>${learned}/${total} từ đã học</span>
      <span>${isMastered ? '🏆 Hoàn thành!' : `Ngày ${batchNum + 1}/3`}</span>
    </div>
    <div class="topic-progress-bar large"><div class="topic-progress-fill" style="width:${pct}%"></div></div>
    ${canStudyToday ? `<button class="btn-start-lesson" id="btn-start-lesson">✨ Bắt đầu bài học hôm nay</button>` : ''}
    ${!isMastered && !canStudyToday ? `<div class="topic-done-today">✅ Đã học hôm nay — Quay lại ngày mai!</div>` : ''}
  `;
  list.appendChild(header);

  if (canStudyToday) {
    header.querySelector('#btn-start-lesson').addEventListener('click', () => startTopicLesson(topic, topicWords, tp));
  }

  // Show word list grouped by batch
  for (let b = 0; b < 3; b++) {
    const batchStart = b * 10;
    const batchEnd = Math.min(batchStart + 10, topicWords.length);
    const batchWords = topicWords.slice(batchStart, batchEnd);
    const isUnlocked = b <= batchNum;

    const batchHeader = document.createElement('div');
    batchHeader.className = 'batch-header';
    batchHeader.innerHTML = `<span>${isUnlocked ? '🔓' : '🔒'} Ngày ${b + 1}</span><span>${batchWords.length} từ</span>`;
    list.appendChild(batchHeader);

    for (const w of batchWords) {
      const isLearned = tp && tp.wordsLearned.includes(w.id);
      const card = document.createElement('div');
      card.className = `word-card${isLearned ? ' learned' : ''}${!isUnlocked ? ' locked' : ''}`;
      card.innerHTML = `
        <div class="word-num">${isLearned ? '✓' : isUnlocked ? '' : '🔒'}</div>
        <div class="word-info">
          <div class="word-top">
            <span class="word-en">${isUnlocked ? w.word : '???'}</span>
            ${isUnlocked && w.ipa ? `<span class="word-ipa">${w.ipa}</span>` : ''}
          </div>
          <div class="word-vi">${isUnlocked ? w.vi : 'Chưa mở khóa'}</div>
        </div>
        ${isUnlocked && w.pos ? `<span class="word-pos">${POS_VI[w.pos] || w.pos}</span>` : ''}
      `;
      if (isUnlocked) card.addEventListener('click', () => openDetail(w.id, null));
      list.appendChild(card);
    }
  }

  // Boss Quiz button for mastered topics
  if (isMastered) {
    const bossDiv = document.createElement('div');
    bossDiv.className = 'boss-quiz-section';
    const hasBadge = tp.bossQuizPassed;
    bossDiv.innerHTML = `
      <div class="boss-quiz-card${hasBadge ? ' earned' : ''}">
        <div class="boss-quiz-icon">${hasBadge ? '🏅' : '👑'}</div>
        <div class="boss-quiz-info">
          <div class="boss-quiz-title">${hasBadge ? 'Huy hiệu Boss Quiz!' : 'Boss Quiz — Thử thách cuối'}</div>
          <div class="boss-quiz-desc">${hasBadge ? `Đã đạt ${tp.bossQuizScore}% chính xác` : '30 câu mix 3 level • Cần 80% để nhận huy hiệu'}</div>
        </div>
        <button class="btn-boss-quiz" id="btn-boss-quiz">${hasBadge ? '🔄 Thử lại' : '⚔️ Chiến!'}</button>
      </div>
    `;
    list.appendChild(bossDiv);
    bossDiv.querySelector('#btn-boss-quiz').addEventListener('click', () => startBossQuiz(topic, topicWords));
  }

  document.getElementById('topic-detail').classList.remove('hidden');
}

// ─── BOSS QUIZ (Phase 4) ──────────────────────────────
async function startBossQuiz(topic, topicWords) {
  quiz = { questions: [], current: 0, xp: 0, combo: 0, maxCombo: 0, correct: 0, level: 1, timer: null, timeLeft: QUIZ_TIME, isBoss: true, bossTopic: topic };

  // Generate 30 questions from this topic, mixing all 3 levels
  const shuffled = [...topicWords].sort(() => Math.random() - 0.5);
  const count = Math.min(30, shuffled.length);

  for (let i = 0; i < count; i++) {
    const word = shuffled[i];
    const lvl = (i % 3) + 1; // cycle L1, L2, L3
    const wrongs = WORDS.filter(w => w.vi !== word.vi && w.word !== word.word && w.topic === word.topic).sort(() => Math.random() - 0.5);
    const fallback = WORDS.filter(w => w.vi !== word.vi && w.word !== word.word && w.topic !== word.topic).sort(() => Math.random() - 0.5);
    const wrongPool = [...wrongs, ...fallback].slice(0, 3);

    if (lvl === 1) {
      const options = [word.vi, ...wrongPool.map(w => w.vi)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: word.word, sub: word.ipa || '', answer: word.vi, options, word });
    } else if (lvl === 2) {
      const options = [word.word, ...wrongPool.map(w => w.word)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: word.vi, sub: 'Chọn từ tiếng Anh đúng', answer: word.word, options, word });
    } else {
      const options = [word.word, ...wrongPool.map(w => w.word)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: '🎧', sub: 'Nghe và chọn từ đúng', answer: word.word, options, word, listen: true });
    }
  }

  // Shuffle questions so levels are mixed
  quiz.questions.sort(() => Math.random() - 0.5);

  showScreen('quiz-game');
  document.getElementById('tab-bar').style.display = 'none';
  document.getElementById('quiz-hud-progress').textContent = `1/${quiz.questions.length}`;
  showQuestion();
}

// ─── TOPIC LESSON (Phase 3) ───────────────────────────
let topicLesson = { topic: null, words: [], results: [], current: 0, allTopicWords: [] };

async function startTopicLesson(topic, allTopicWords, tp) {
  const batchStart = tp.currentBatch * 10;
  const batchEnd = Math.min(batchStart + 10, allTopicWords.length);
  const batchWords = allTopicWords.slice(batchStart, batchEnd);
  const carryOverWords = tp.wrongCarryOver.map(id => allTopicWords.find(w => w.id === id)).filter(Boolean);
  const lessonWords = [...carryOverWords.filter(w => !batchWords.find(bw => bw.id === w.id)), ...batchWords];

  topicLesson = { topic, words: lessonWords, results: [], current: 0, allTopicWords };
  showTopicQuestion();
}

function showTopicQuestion() {
  if (topicLesson.current >= topicLesson.words.length) { finishTopicLesson(); return; }
  const word = topicLesson.words[topicLesson.current];
  const wrongChoices = getWrongChoices(word.vi, 3, word);
  const choices = [word.vi, ...wrongChoices].sort(() => Math.random() - 0.5);

  const body = document.getElementById('detail-body');
  body.innerHTML = `
    <div class="topic-lesson-hud">
      <span>${topicLesson.current + 1}/${topicLesson.words.length}</span>
      <span>${topicLesson.topic.icon} ${topicLesson.topic.name_vi}</span>
    </div>
    <div class="text-center">
      <div class="detail-word">${word.word}</div>
      ${word.ipa ? `<div class="detail-ipa">${word.ipa}</div>` : ''}
    </div>
    <div class="speak-row"><button class="speak-btn" id="tl-speak">🔊 Nghe phát âm</button></div>
    <div class="quiz-prompt">Chọn nghĩa đúng:</div>
    <div class="quiz-options" id="quiz-options">
      ${choices.map((c, i) => `<button class="quiz-option" data-answer="${c}">${String.fromCharCode(65 + i)}. ${c}</button>`).join('')}
    </div>
  `;

  document.getElementById('tl-speak').addEventListener('click', () => TTS.speakEN(word.word));
  document.getElementById('detail-actions').style.display = 'none';

  document.querySelectorAll('.quiz-option').forEach(btn => {
    btn.addEventListener('click', () => handleTopicAnswer(word, btn.dataset.answer));
  });

  showScreen('detail-screen');
}

function handleTopicAnswer(word, selected) {
  const isCorrect = selected === word.vi;
  topicLesson.results.push({ wordId: word.id, correct: isCorrect });

  document.querySelectorAll('.quiz-option').forEach(btn => {
    btn.disabled = true;
    btn.classList.add('quiz-disabled');
    if (btn.dataset.answer === word.vi) btn.classList.add('quiz-correct');
    else if (btn.dataset.answer === selected && !isCorrect) btn.classList.add('quiz-wrong');
  });

  const banner = document.createElement('div');
  banner.innerHTML = isCorrect
    ? `<div class="quiz-result quiz-result-correct">✅ Chính xác!</div>`
    : `<div class="quiz-result quiz-result-wrong">❌ Đáp án: <strong>${word.vi}</strong></div>`;
  document.getElementById('detail-body').appendChild(banner);

  if (isCorrect) { SFX.playCorrect(); TTS.speakEN(word.word); DB.updateProgress(word.id, true); }
  else { SFX.playWrong(); DB.updateProgress(word.id, false); }

  topicLesson.current++;
  setTimeout(showTopicQuestion, 1200);
}

async function finishTopicLesson() {
  const correct = topicLesson.results.filter(r => r.correct).length;
  const total = topicLesson.results.length;
  const accuracy = Math.round((correct / total) * 100);
  const stars = accuracy >= 90 ? '⭐⭐⭐' : accuracy >= 70 ? '⭐⭐' : accuracy >= 50 ? '⭐' : '💪';

  // Save to DB
  await DB.completeTopicBatch(topicLesson.topic.name, topicLesson.results, topicLesson.allTopicWords);
  await DB.incrementStat(today(), 'words_learned');
  SFX.playSuccess();

  const tp = await DB.getTopicProgress(topicLesson.topic.name);
  const isMastered = tp?.status === 'mastered';

  document.getElementById('quiz-results-body').innerHTML = `
    <div class="quiz-results-card">
      <div class="results-stars">${isMastered ? '🏆' : stars}</div>
      <div class="results-title">${isMastered ? 'Hoàn thành chủ đề!' : accuracy >= 70 ? 'Tốt lắm!' : 'Cố gắng thêm!'}</div>
      <div class="results-sub">${topicLesson.topic.icon} ${topicLesson.topic.name_vi}</div>
      <div class="results-stats">
        <div class="results-stat"><div class="results-stat-value acc">${correct}/${total}</div><div class="results-stat-label">Đúng</div></div>
        <div class="results-stat"><div class="results-stat-value combo">${accuracy}%</div><div class="results-stat-label">Chính xác</div></div>
      </div>
      ${!isMastered && topicLesson.results.some(r => !r.correct) ? `<div class="topic-carryover-note">📌 ${total - correct} từ sai sẽ quay lại ngày mai</div>` : ''}
      <button class="results-btn results-btn-secondary" id="results-back" style="margin-top:16px">🏠 Về trang chính</button>
    </div>
  `;

  showScreen('quiz-results');
  document.getElementById('quiz-results').classList.add('active');
  document.getElementById('tab-bar').style.display = 'none';

  document.getElementById('results-back').addEventListener('click', () => {
    document.getElementById('quiz-results').classList.remove('active');
    switchTab('topics-screen');
  });
}

// ─── QUIZ MENU ─────────────────────────────────────────
const QUIZ_LEVELS_EN = [
  { id: 1, name: 'L1: EN → VI', desc: 'Xem từ tiếng Anh → chọn nghĩa đúng', icon: '🇺🇸', unlock: 0 },
  { id: 2, name: 'L2: VI → EN', desc: 'Xem nghĩa tiếng Việt → chọn từ đúng', icon: '🇻🇳', unlock: 0 },
  { id: 3, name: 'L3: Nghe → Chọn', desc: 'Nghe phát âm → chọn từ đúng', icon: '🎧', unlock: 0 },
  { id: 4, name: 'L4: Ghép câu', desc: 'Sắp xếp từ đúng thứ tự thành câu hoàn chỉnh', icon: '🧩', unlock: 0 },
  { id: 5, name: 'L5: Điền từ', desc: 'Điền từ đúng vào chỗ trống trong câu', icon: '✍️', unlock: 0 },
  { id: 6, name: 'L6: Dịch câu', desc: 'Đọc câu tiếng Anh → gõ nghĩa tiếng Việt', icon: '🌐', unlock: 0 },
];
const QUIZ_LEVELS_ZH = [
  { id: 1, name: 'L1: 汉字 → VI', desc: 'Xem Hán tự → chọn nghĩa tiếng Việt', icon: '🇨🇳', unlock: 0 },
  { id: 2, name: 'L2: VI → 汉字', desc: 'Xem nghĩa → chọn Hán tự đúng', icon: '🇻🇳', unlock: 0 },
  { id: 4, name: 'L4: 汉字 → Pinyin', desc: 'Xem Hán tự → chọn Pinyin đúng', icon: '📝', unlock: 0 },
  { id: 3, name: 'L3: Nghe → Chọn', desc: 'Nghe phát âm → chọn Hán tự đúng', icon: '🎧', unlock: 0 },
];
function getQuizLevels() { return currentLang === 'zh' ? QUIZ_LEVELS_ZH : QUIZ_LEVELS_EN; }
// Keep backward compat
const QUIZ_LEVELS = QUIZ_LEVELS_EN;

async function loadQuizMenu() {
  const menu = document.getElementById('quiz-menu');
  const bankCount = await DB.getQuizBankCount();

  menu.innerHTML = `
    ${bankCount > 0 ? `
    <div class="section-header" style="padding:8px 0 12px"><span>🧠</span><h2>Kho ôn tập</h2></div>
    <div class="quiz-level-card quiz-bank-card" id="quiz-bank-card">
      <div class="quiz-level-icon" style="background:linear-gradient(135deg,var(--primary),var(--secondary))">🧠</div>
      <div class="quiz-level-info">
        <div class="quiz-level-name">Ôn tập thông minh</div>
        <div class="quiz-level-desc">Mix tất cả chủ đề đã học • Từ hay sai sẽ hiện nhiều hơn</div>
      </div>
      <span class="quiz-level-badge">${bankCount} từ</span>
    </div>
    ` : `
    <div class="quiz-bank-empty">
      <div>🧠</div>
      <p>Kho ôn tập trống</p>
      <p class="quiz-bank-hint">Học chủ đề trong tab "Chủ đề" để thêm từ vào kho!</p>
    </div>
    `}
    <div class="section-header" style="padding:8px 0 12px"><span>🎮</span><h2>Chọn dạng quiz</h2></div>
    ${getQuizLevels().map(l => `
      <div class="quiz-level-card" data-level="${l.id}">
        <div class="quiz-level-icon" style="background:var(--surface-light)">${l.icon}</div>
        <div class="quiz-level-info">
          <div class="quiz-level-name">${l.name}</div>
          <div class="quiz-level-desc">${l.desc}</div>
        </div>
        <span class="quiz-level-badge">10 câu</span>
      </div>
    `).join('')}
    ${'webkitSpeechRecognition' in window || 'SpeechRecognition' in window ? `
    <div class="section-header" style="padding:16px 0 12px"><span>🎙️</span><h2>Luyện tập</h2></div>
    <div class="quiz-level-card pronun-card" id="pronun-card">
      <div class="quiz-level-icon" style="background:linear-gradient(135deg,#FF6B6B,#EE5A24)">🎤</div>
      <div class="quiz-level-info">
        <div class="quiz-level-name">Luyện phát âm</div>
        <div class="quiz-level-desc">Nghe → Nhắc lại → So sánh phát âm của bạn</div>
      </div>
      <span class="quiz-level-badge">∞</span>
    </div>
    ` : ''}
  `;

  // Quiz bank click
  const bankCard = document.getElementById('quiz-bank-card');
  if (bankCard) bankCard.addEventListener('click', () => startQuizFromBank());

  menu.querySelectorAll('.quiz-level-card:not(.quiz-bank-card):not(.pronun-card)').forEach(card => {
    if (card.dataset.level) card.addEventListener('click', () => startQuiz(parseInt(card.dataset.level)));
  });

  // Pronunciation practice click
  const pronunCard = document.getElementById('pronun-card');
  if (pronunCard) pronunCard.addEventListener('click', () => startPronunciationPractice());
}

// ─── QUIZ GAME ENGINE ──────────────────────────────────
let quiz = { questions: [], current: 0, xp: 0, combo: 0, maxCombo: 0, correct: 0, level: 1, timer: null, timeLeft: 0 };
const QUIZ_TIME = 12; // seconds per question
const QUIZ_COUNT = 10;

async function startQuiz(level) {
  quiz = { questions: [], current: 0, xp: 0, combo: 0, maxCombo: 0, correct: 0, level, timer: null, timeLeft: QUIZ_TIME };

  // Build questions from words of current language
  const allIds = await DB.getAllWordIdsByLanguage(currentLang);
  const shuffled = allIds.sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, QUIZ_COUNT);

  for (const id of picked) {
    const word = await DB.getWord(id);
    if (!word) continue;
    const isZH = word.lang === 'zh';
    // Generate 3 wrong options from same language
    const wrongs = WORDS.filter(w => w.vi !== word.vi && w.word !== word.word && w.topic === word.topic && (w.lang || 'en') === currentLang).sort(() => Math.random() - 0.5);
    const fallback = WORDS.filter(w => w.vi !== word.vi && w.word !== word.word && w.topic !== word.topic && (w.lang || 'en') === currentLang).sort(() => Math.random() - 0.5);
    const wrongPool = [...wrongs, ...fallback].slice(0, 3);

    if (level === 1) {
      // Word → VI (EN→VI or 汉字→VI)
      const options = [word.vi, ...wrongPool.map(w => w.vi)].sort(() => Math.random() - 0.5);
      const sub = isZH ? (word.pinyin || '') : (word.ipa || '');
      quiz.questions.push({ prompt: word.word, sub, answer: word.vi, options, word, promptStyle: isZH ? 'font-size:42px' : '' });
    } else if (level === 2) {
      // VI → Word (VI→EN or VI→汉字)
      const options = [word.word, ...wrongPool.map(w => w.word)].sort(() => Math.random() - 0.5);
      const sub = isZH ? 'Chọn Hán tự đúng' : 'Chọn từ tiếng Anh đúng';
      quiz.questions.push({ prompt: word.vi, sub, answer: word.word, options, word, optionStyle: isZH ? 'font-size:22px' : '' });
    } else if (level === 3) {
      // Listen → choose
      const options = [word.word, ...wrongPool.map(w => w.word)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: '🎧', sub: isZH ? 'Nghe và chọn Hán tự đúng' : 'Nghe và chọn từ đúng', answer: word.word, options, word, listen: true, optionStyle: isZH ? 'font-size:22px' : '' });
    } else if (level === 4 && isZH) {
      // 汉字 → Pinyin (Chinese only)
      const wrongPy = getWrongPinyin(word.pinyin, 3, word);
      const options = [word.pinyin, ...wrongPy].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: word.word, sub: 'Chọn Pinyin đúng', answer: word.pinyin, options, word, promptStyle: 'font-size:48px' });
    } else if (level === 4 && !isZH) {
      // Reorder sentence (English only)
      const sentence = word.ex_en || `I like the word "${word.word}".`;
      // Clean sentence: remove quotes, extra spaces
      const cleanSentence = sentence.replace(/[""]/g, '').trim();
      const sentenceWords = cleanSentence.split(/\s+/);
      // Only use sentences with 3-8 words for good UX
      if (sentenceWords.length >= 3 && sentenceWords.length <= 8) {
        const shuffledWords = [...sentenceWords].sort(() => Math.random() - 0.5);
        // Ensure shuffled is actually different from original
        if (shuffledWords.join(' ') === sentenceWords.join(' ')) {
          shuffledWords.reverse();
        }
        quiz.questions.push({
          prompt: word.vi, sub: '🧩 Sắp xếp từ thành câu đúng',
          answer: sentenceWords.join(' '), word,
          reorder: true, reorderWords: shuffledWords, reorderCorrect: sentenceWords,
          hint: word.ex_vi || ''
        });
      } else {
        // Fallback to L1 for too-short/long sentences
        const options = [word.vi, ...wrongPool.map(w => w.vi)].sort(() => Math.random() - 0.5);
        quiz.questions.push({ prompt: word.word, sub: word.ipa || '', answer: word.vi, options, word });
      }
    } else if (level === 5) {
      // Fill in blank — use example sentence
      const sentence = isZH ? (word.ex_zh || `我喜欢「${word.word}」。`) : (word.ex_en || `I like the word "${word.word}".`);
      const blanked = sentence.replace(word.word, '______');
      quiz.questions.push({ prompt: blanked, sub: '✍️ Điền từ vào chỗ trống', answer: word.word.toLowerCase(), word, fillBlank: true });
    } else if (level === 6) {
      // Translate — show word, user types VI
      const sub = isZH ? `${word.pinyin || ''} — Gõ nghĩa tiếng Việt` : `${word.ipa || ''} — Gõ nghĩa tiếng Việt`;
      quiz.questions.push({ prompt: word.word, sub, answer: word.vi.toLowerCase(), word, translate: true, promptStyle: isZH ? 'font-size:42px' : '' });
    }
  }

  showScreen('quiz-game');
  document.getElementById('tab-bar').style.display = 'none';
  showQuestion();
}

function showQuestion() {
  if (quiz.current >= quiz.questions.length) { showResults(); return; }
  const q = quiz.questions[quiz.current];

  // Update HUD
  document.getElementById('quiz-hud-progress').textContent = `${quiz.current + 1}/${quiz.questions.length}`;
  document.getElementById('quiz-hud-combo').textContent = `🔥 ${quiz.combo}`;
  document.getElementById('quiz-hud-xp').textContent = `⭐ ${quiz.xp}`;

  // Render question
  const body = document.getElementById('quiz-game-body');

  if (q.reorder) {
    // Reorder sentence quiz (L4 EN)
    body.innerHTML = `
      <div class="quiz-q-sub" style="margin-bottom:8px">📖 ${q.prompt}</div>
      <div class="quiz-q-sub" style="font-size:12px;color:var(--text-muted);margin-bottom:20px">${q.hint}</div>
      <div class="quiz-reorder-answer" id="reorder-answer"></div>
      <div class="quiz-reorder-hint" id="reorder-hint">Bấm từ theo thứ tự đúng</div>
      <div class="quiz-reorder-pool" id="reorder-pool">
        ${q.reorderWords.map((w, i) => `<button class="reorder-tile" data-word="${w}" data-idx="${i}">${w}</button>`).join('')}
      </div>
      <div class="quiz-reorder-actions">
        <button class="reorder-undo-btn" id="reorder-undo" disabled>↩ Hoàn tác</button>
        <button class="quiz-fill-submit" id="reorder-check" disabled>Kiểm tra</button>
      </div>
    `;
    setupReorderHandlers(q);
  } else if (q.fillBlank || q.translate) {
    // Text input questions (L5, L6)
    body.innerHTML = `
      <div class="quiz-q-word" ${q.promptStyle ? `style="${q.promptStyle}"` : ''}>${q.fillBlank ? '' : q.prompt}</div>
      ${q.fillBlank ? `<div class="quiz-fill-sentence">${q.prompt}</div>` : ''}
      <div class="quiz-q-sub">${q.sub}</div>
      <button class="speak-btn" id="quiz-listen-btn" style="margin-bottom:20px">🔊 Nghe phát âm</button>
      <input type="text" class="quiz-fill-input" id="quiz-text-input" placeholder="${q.fillBlank ? (currentLang === 'zh' ? 'Gõ từ tiếng Trung...' : 'Gõ từ tiếng Anh...') : 'Gõ nghĩa tiếng Việt...'}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="quiz-fill-submit" id="quiz-text-submit">Kiểm tra</button>
    `;

    const listenBtn = document.getElementById('quiz-listen-btn');
    listenBtn.addEventListener('click', () => currentLang === 'zh' ? TTS.speakZH(q.word.word) : TTS.speakEN(q.word.word));

    const input = document.getElementById('quiz-text-input');
    const submitBtn = document.getElementById('quiz-text-submit');

    const checkAnswer = () => {
      const userAns = input.value.trim().toLowerCase();
      if (!userAns) return;
      const isCorrect = userAns === q.answer || (q.translate && q.word.vi.toLowerCase().includes(userAns));
      handleTextQuizAnswer(q, isCorrect, input, submitBtn);
    };

    submitBtn.addEventListener('click', checkAnswer);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkAnswer(); });
    setTimeout(() => input.focus(), 300);
  } else {
    // Multiple choice (L1, L2, L3, L4)
    const showSpeakBtn = q.listen || quiz.level === 1 || quiz.level === 2 || quiz.level === 4 || quiz.isBank;
    body.innerHTML = `
      <div class="quiz-q-word" ${q.promptStyle ? `style="${q.promptStyle}"` : ''}>${q.prompt}</div>
      <div class="quiz-q-sub">${q.sub}</div>
      ${showSpeakBtn ? `<button class="speak-btn" id="quiz-listen-btn" style="margin-bottom:20px">🔊 Nghe phát âm</button>` : ''}
      <div class="quiz-q-options">
        ${q.options.map((o, i) => `<button class="quiz-q-btn" data-answer="${o}" ${q.optionStyle ? `style="${q.optionStyle}"` : ''}>${String.fromCharCode(65 + i)}. ${o}</button>`).join('')}
      </div>
    `;

    if (q.listen) {
      currentLang === 'zh' ? TTS.speakZH(q.word.word) : TTS.speakEN(q.word.word);
    }
    const listenBtn = document.getElementById('quiz-listen-btn');
    if (listenBtn) listenBtn.addEventListener('click', () => currentLang === 'zh' ? TTS.speakZH(q.word.word) : TTS.speakEN(q.word.word));

    // Attach answer handlers
    body.querySelectorAll('.quiz-q-btn').forEach(btn => {
      btn.addEventListener('click', () => handleQuizAnswer(btn, q));
    });
  }

  // Start timer
  startTimer();
}

function startTimer() {
  quiz.timeLeft = QUIZ_TIME;
  const fill = document.getElementById('quiz-timer-fill');
  fill.style.width = '100%';
  fill.classList.remove('danger');

  if (quiz.timer) clearInterval(quiz.timer);
  quiz.timer = setInterval(() => {
    quiz.timeLeft -= 0.1;
    const pct = Math.max(0, (quiz.timeLeft / QUIZ_TIME) * 100);
    fill.style.width = pct + '%';
    if (pct < 30) fill.classList.add('danger');
    if (quiz.timeLeft <= 0) {
      clearInterval(quiz.timer);
      // Time up - auto wrong
      SFX.playWrong();
      const q = quiz.questions[quiz.current];
      if (q && q.reorder) {
        // Reorder timeout: show correct answer, disable pool
        const pool = document.getElementById('reorder-pool');
        const answerZone = document.getElementById('reorder-answer');
        if (pool) pool.style.pointerEvents = 'none';
        const undoBtn = document.getElementById('reorder-undo');
        const checkBtn = document.getElementById('reorder-check');
        if (undoBtn) undoBtn.disabled = true;
        if (checkBtn) checkBtn.disabled = true;
        if (answerZone) {
          const correctDiv = document.createElement('div');
          correctDiv.className = 'quiz-result quiz-result-wrong';
          correctDiv.innerHTML = `⏰ Hết giờ! Đáp án: <strong>${q.answer}</strong>`;
          correctDiv.style.cssText = 'margin-top:12px;text-align:center';
          answerZone.parentElement.appendChild(correctDiv);
        }
      } else {
        const btns = document.querySelectorAll('.quiz-q-btn');
        btns.forEach(b => {
          b.classList.add('disabled');
          if (b.dataset.answer === q.answer) b.classList.add('correct');
        });
      }
      quiz.combo = 0;
      quiz.current++;
      setTimeout(showQuestion, 1200);
    }
  }, 100);
}

function handleQuizAnswer(btn, q) {
  clearInterval(quiz.timer);
  const isCorrect = btn.dataset.answer === q.answer;

  // Highlight all buttons
  document.querySelectorAll('.quiz-q-btn').forEach(b => {
    b.classList.add('disabled');
    if (b.dataset.answer === q.answer) b.classList.add('correct');
  });

  if (isCorrect) {
    quiz.correct++;
    quiz.combo++;
    if (quiz.combo > quiz.maxCombo) quiz.maxCombo = quiz.combo;

    // XP: base 10 + time bonus + combo bonus
    let xp = 10;
    xp += Math.round(quiz.timeLeft); // time bonus
    if (quiz.combo >= 3) xp += 5;
    if (quiz.combo >= 5) xp += 10;
    if (quiz.combo >= 10) xp += 20;
    quiz.xp += xp;

    // Combo popup
    if (quiz.combo >= 3) showComboPopup(quiz.combo);

    // Sound + Update progress
    SFX.playCorrect();
    DB.updateProgress(q.word.id || 1, true);
  } else {
    btn.classList.add('wrong');
    SFX.playWrong();
    quiz.combo = 0;
    DB.updateProgress(q.word.id || 1, false);
  }

  document.getElementById('quiz-hud-combo').textContent = `🔥 ${quiz.combo}`;
  document.getElementById('quiz-hud-xp').textContent = `⭐ ${quiz.xp}`;

  quiz.current++;
  setTimeout(showQuestion, 1000);
}

function showComboPopup(combo) {
  const popup = document.createElement('div');
  popup.className = 'combo-popup';
  popup.textContent = `🔥 x${combo}`;
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 700);
}

// ─── REORDER QUIZ HANDLERS (L4 EN) ─────────────────────
function setupReorderHandlers(q) {
  const pool = document.getElementById('reorder-pool');
  const answerZone = document.getElementById('reorder-answer');
  const undoBtn = document.getElementById('reorder-undo');
  const checkBtn = document.getElementById('reorder-check');
  const hint = document.getElementById('reorder-hint');
  const placed = []; // track placed words in order

  // Tap to place
  pool.addEventListener('click', (e) => {
    const tile = e.target.closest('.reorder-tile');
    if (!tile || tile.classList.contains('used')) return;

    // Move to answer zone
    tile.classList.add('used');
    const answerTile = document.createElement('span');
    answerTile.className = 'reorder-answer-tile';
    answerTile.textContent = tile.dataset.word;
    answerTile.dataset.idx = tile.dataset.idx;
    answerZone.appendChild(answerTile);
    placed.push({ word: tile.dataset.word, idx: tile.dataset.idx });

    // Animate
    answerTile.style.animation = 'tilePop 0.25s ease';
    SFX.playTap && SFX.playTap();

    // Update buttons
    undoBtn.disabled = false;
    hint.style.display = placed.length > 0 ? 'none' : '';
    checkBtn.disabled = placed.length < q.reorderCorrect.length;
  });

  // Undo last placed word
  undoBtn.addEventListener('click', () => {
    if (placed.length === 0) return;
    const last = placed.pop();
    // Remove from answer zone
    const lastTile = answerZone.querySelector(`.reorder-answer-tile[data-idx="${last.idx}"]`);
    if (lastTile) lastTile.remove();
    // Restore in pool
    const poolTile = pool.querySelector(`.reorder-tile[data-idx="${last.idx}"]`);
    if (poolTile) poolTile.classList.remove('used');

    undoBtn.disabled = placed.length === 0;
    hint.style.display = placed.length > 0 ? 'none' : '';
    checkBtn.disabled = true;
  });

  // Check answer
  checkBtn.addEventListener('click', () => {
    clearInterval(quiz.timer);
    const userSentence = placed.map(p => p.word).join(' ');
    // Case-insensitive comparison, ignore trailing punctuation differences
    const normalize = s => s.toLowerCase().replace(/[.,!?;:]+$/g, '').trim();
    const isCorrect = normalize(userSentence) === normalize(q.answer);

    // Disable further interaction
    pool.style.pointerEvents = 'none';
    undoBtn.disabled = true;
    checkBtn.disabled = true;

    // Visual feedback
    const answerTiles = answerZone.querySelectorAll('.reorder-answer-tile');
    if (isCorrect) {
      answerTiles.forEach(t => t.classList.add('correct'));
      quiz.correct++;
      quiz.combo++;
      if (quiz.combo > quiz.maxCombo) quiz.maxCombo = quiz.combo;
      let xp = 15; // reorder is harder, more XP
      xp += Math.round(quiz.timeLeft);
      if (quiz.combo >= 3) xp += 5;
      if (quiz.combo >= 5) xp += 10;
      quiz.xp += xp;
      if (quiz.combo >= 3) showComboPopup(quiz.combo);
      SFX.playCorrect();
      DB.updateProgress(q.word.id || 1, true);
    } else {
      // Show which words are wrong
      answerTiles.forEach((t, i) => {
        if (i < q.reorderCorrect.length && t.textContent === q.reorderCorrect[i]) {
          t.classList.add('correct');
        } else {
          t.classList.add('wrong');
        }
      });
      // Show correct answer below
      const correctDiv = document.createElement('div');
      correctDiv.className = 'quiz-result quiz-result-wrong';
      correctDiv.innerHTML = `Đáp án: <strong>${q.answer}</strong>`;
      correctDiv.style.cssText = 'margin-top:12px;text-align:center';
      answerZone.parentElement.appendChild(correctDiv);
      quiz.combo = 0;
      SFX.playWrong();
      DB.updateProgress(q.word.id || 1, false);
    }

    document.getElementById('quiz-hud-combo').textContent = `🔥 ${quiz.combo}`;
    document.getElementById('quiz-hud-xp').textContent = `⭐ ${quiz.xp}`;
    quiz.current++;
    setTimeout(showQuestion, 1200);
  });
}

// Handle text-input quiz answers (L5, L6)
function handleTextQuizAnswer(q, isCorrect, input, submitBtn) {
  clearInterval(quiz.timer);
  input.disabled = true;
  submitBtn.disabled = true;

  if (isCorrect) {
    input.classList.add('correct');
    quiz.correct++;
    quiz.combo++;
    if (quiz.combo > quiz.maxCombo) quiz.maxCombo = quiz.combo;
    const baseXP = 10;
    const comboBonus = quiz.combo >= 10 ? 5 : quiz.combo >= 5 ? 3 : quiz.combo >= 3 ? 1 : 0;
    quiz.xp += baseXP + comboBonus;
    if (quiz.combo >= 3) showComboPopup(quiz.combo);
    SFX.playCorrect();
    TTS.speakEN(q.word.word);
    DB.updateProgress(q.word.id || 1, true);
  } else {
    input.classList.add('wrong');
    quiz.combo = 0;
    SFX.playWrong();
    DB.updateProgress(q.word.id || 1, false);
    // Show correct answer
    const hint = document.createElement('div');
    hint.className = 'quiz-result quiz-result-wrong';
    hint.innerHTML = `Đáp án: <strong>${q.answer}</strong>`;
    hint.style.cssText = 'margin-top:10px;text-align:center';
    input.parentElement.appendChild(hint);
  }

  document.getElementById('quiz-hud-combo').textContent = `🔥 ${quiz.combo}`;
  document.getElementById('quiz-hud-xp').textContent = `⭐ ${quiz.xp}`;

  quiz.current++;
  setTimeout(showQuestion, 1200);
}

async function showResults() {
  clearInterval(quiz.timer);
  const accuracy = Math.round((quiz.correct / quiz.questions.length) * 100);
  const stars = accuracy >= 90 ? '⭐⭐⭐' : accuracy >= 70 ? '⭐⭐' : accuracy >= 50 ? '⭐' : '💪';
  const title = accuracy >= 90 ? 'Xuất sắc!' : accuracy >= 70 ? 'Tốt lắm!' : accuracy >= 50 ? 'Khá ổn!' : 'Cố gắng thêm!';

  // Boss Quiz special handling
  if (quiz.isBoss) {
    const passed = accuracy >= 80;
    if (passed) {
      SFX.playSuccess();
      await DB.updateTopicProgress(quiz.bossTopic.name, { bossQuizPassed: true, bossQuizScore: accuracy });
    } else {
      SFX.playWrong();
    }

    const resultsScreen = document.getElementById('quiz-results');
    document.getElementById('quiz-results-body').innerHTML = `
      <div class="quiz-results-card">
        <div class="results-stars">${passed ? '🏅' : '👑'}</div>
        <div class="results-title">${passed ? 'Boss Quiz — PASSED!' : 'Chưa đạt 80%'}</div>
        <div class="results-sub">${quiz.bossTopic.icon} ${quiz.bossTopic.name_vi} • ${quiz.correct}/${quiz.questions.length} câu</div>
        <div class="results-stats">
          <div class="results-stat"><div class="results-stat-value acc">${accuracy}%</div><div class="results-stat-label">Chính xác</div></div>
          <div class="results-stat"><div class="results-stat-value xp">${quiz.xp}</div><div class="results-stat-label">XP</div></div>
          <div class="results-stat"><div class="results-stat-value combo">x${quiz.maxCombo}</div><div class="results-stat-label">Max Combo</div></div>
        </div>
        ${passed ? '<div class="boss-badge-earned">🏅 Đã nhận huy hiệu!</div>' : '<div class="topic-carryover-note">Cần ≥80% để nhận huy hiệu. Thử lại!</div>'}
        <button class="results-btn results-btn-secondary" id="results-back" style="margin-top:16px">🏠 Về trang chính</button>
      </div>
    `;

    showScreen('quiz-results');
    resultsScreen.classList.add('active');
    document.getElementById('tab-bar').style.display = 'none';

    document.getElementById('results-back').addEventListener('click', () => {
      resultsScreen.classList.remove('active');
      switchTab('topics-screen');
    });
    return;
  }

  // Regular quiz
  SFX.playSuccess();
  DB.incrementStat(today(), 'words_learned');

  const resultsScreen = document.getElementById('quiz-results');
  document.getElementById('quiz-results-body').innerHTML = `
    <div class="quiz-results-card">
      <div class="results-stars">${stars}</div>
      <div class="results-title">${title}</div>
      <div class="results-sub">${quiz.isBank ? '🧠 Ôn tập thông minh' : (getQuizLevels().find(l => l.id === quiz.level)?.name || '')}</div>
      <div class="results-stats">
        <div class="results-stat"><div class="results-stat-value xp">${quiz.xp}</div><div class="results-stat-label">XP</div></div>
        <div class="results-stat"><div class="results-stat-value acc">${accuracy}%</div><div class="results-stat-label">Chính xác</div></div>
        <div class="results-stat"><div class="results-stat-value combo">x${quiz.maxCombo}</div><div class="results-stat-label">Max Combo</div></div>
      </div>
      <button class="results-btn results-btn-primary" id="results-retry">🔄 Chơi lại</button>
      <button class="results-btn results-btn-secondary" id="results-back" style="margin-top:8px">🏠 Về trang chính</button>
    </div>
  `;

  showScreen('quiz-results');
  resultsScreen.classList.add('active');
  document.getElementById('tab-bar').style.display = 'none';

  document.getElementById('results-retry').addEventListener('click', () => {
    resultsScreen.classList.remove('active');
    if (quiz.isBank) startQuizFromBank();
    else startQuiz(quiz.level);
  });
  document.getElementById('results-back').addEventListener('click', () => {
    resultsScreen.classList.remove('active');
    switchTab('home-screen');
    loadDailyWords();
    loadStats();
  });
}

function endQuiz() {
  clearInterval(quiz.timer);
  document.getElementById('quiz-results').classList.remove('active');
  switchTab('quiz-screen');
}

// ─── QUIZ FROM BANK (Phase 3: SRS-weighted review) ────
async function startQuizFromBank() {
  const smartWords = await DB.getSmartQuizWords(10);
  if (smartWords.length === 0) return;

  quiz = { questions: [], current: 0, xp: 0, combo: 0, maxCombo: 0, correct: 0, level: 1, timer: null, timeLeft: QUIZ_TIME, isBank: true };

  for (const entry of smartWords) {
    const word = await DB.getWord(entry.wordId);
    if (!word) continue;
    const wrongs = WORDS.filter(w => w.vi !== word.vi && w.word !== word.word && w.topic === word.topic).sort(() => Math.random() - 0.5);
    const fallback = WORDS.filter(w => w.vi !== word.vi && w.word !== word.word && w.topic !== word.topic).sort(() => Math.random() - 0.5);
    const wrongPool = [...wrongs, ...fallback].slice(0, 3);
    // Random level 1, 2, or 3
    const lvl = Math.floor(Math.random() * 3) + 1;
    if (lvl === 1) {
      const options = [word.vi, ...wrongPool.map(w => w.vi)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: word.word, sub: word.ipa || '', answer: word.vi, options, word });
    } else if (lvl === 2) {
      const options = [word.word, ...wrongPool.map(w => w.word)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: word.vi, sub: 'Chọn từ tiếng Anh đúng', answer: word.word, options, word });
    } else {
      const options = [word.word, ...wrongPool.map(w => w.word)].sort(() => Math.random() - 0.5);
      quiz.questions.push({ prompt: '🎧', sub: 'Nghe và chọn từ đúng', answer: word.word, options, word, listen: true });
    }
  }

  showScreen('quiz-game');
  document.getElementById('tab-bar').style.display = 'none';
  showQuestion();
}

// ─── PRONUNCIATION PRACTICE ─────────────────────────────
let pronun = { words: [], current: 0, correct: 0, recognition: null };

async function startPronunciationPractice() {
  // Pick 10 random words from current language
  const allIds = await DB.getAllWordIdsByLanguage(currentLang);
  const shuffled = allIds.sort(() => Math.random() - 0.5).slice(0, 10);
  const words = [];
  for (const id of shuffled) {
    const w = await DB.getWord(id);
    if (w) words.push(w);
  }
  if (words.length === 0) return;

  pronun = { words, current: 0, correct: 0, recognition: null };

  showScreen('pronun-screen');
  document.getElementById('tab-bar').style.display = 'none';

  // Close button
  document.getElementById('btn-pronun-close').onclick = () => {
    stopRecognition();
    switchTab('quiz-screen');
    loadQuizMenu();
  };

  showPronunWord();
}

function showPronunWord() {
  if (pronun.current >= pronun.words.length) {
    showPronunResults();
    return;
  }

  const w = pronun.words[pronun.current];
  const isZH = w.lang === 'zh';
  document.getElementById('pronun-counter').textContent = `${pronun.current + 1} / ${pronun.words.length}`;
  document.getElementById('pronun-score').textContent = `✅ ${pronun.correct}`;

  const body = document.getElementById('pronun-body');
  body.innerHTML = `
    <div class="pronun-word" ${isZH ? 'style="font-size:56px"' : ''}>${w.word}</div>
    <div class="pronun-sub">${isZH ? (w.pinyin || '') : (w.ipa || '')} — ${w.vi}</div>
    <button class="pronun-listen-btn" id="pronun-listen">🔊 Nghe mẫu</button>
    <div class="pronun-mic-area" id="pronun-mic-area">
      <button class="pronun-mic-btn" id="pronun-mic">
        <span class="pronun-mic-icon">🎤</span>
        <span class="pronun-mic-label">Bấm để nói</span>
      </button>
      <div class="pronun-mic-wave" id="pronun-wave"></div>
    </div>
    <div class="pronun-result" id="pronun-result"></div>
    <button class="pronun-next-btn hidden" id="pronun-next">Từ tiếp theo →</button>
  `;

  // Listen button
  document.getElementById('pronun-listen').addEventListener('click', () => {
    isZH ? TTS.speakZH(w.word) : TTS.speakEN(w.word);
  });

  // Auto-play pronunciation
  setTimeout(() => { isZH ? TTS.speakZH(w.word) : TTS.speakEN(w.word); }, 400);

  // Mic button
  document.getElementById('pronun-mic').addEventListener('click', () => startListening(w));

  // Next button
  document.getElementById('pronun-next').addEventListener('click', () => {
    pronun.current++;
    showPronunWord();
  });
}

function startListening(word) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('pronun-result').innerHTML = '<div class="pronun-error">⚠️ Trình duyệt không hỗ trợ nhận diện giọng nói</div>';
    return;
  }

  stopRecognition();

  const isZH = word.lang === 'zh';
  const recognition = new SpeechRecognition();
  recognition.lang = isZH ? 'zh-CN' : 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 3;
  pronun.recognition = recognition;

  // UI: recording state
  const micBtn = document.getElementById('pronun-mic');
  const wave = document.getElementById('pronun-wave');
  const micArea = document.getElementById('pronun-mic-area');
  micBtn.classList.add('recording');
  micBtn.querySelector('.pronun-mic-label').textContent = 'Đang nghe...';
  wave.classList.add('active');
  micArea.classList.add('recording');

  recognition.onresult = (event) => {
    const results = event.results[0];
    const transcript = results[0].transcript.trim();
    const confidence = results[0].confidence;

    // Check all alternatives for a match
    let bestMatch = transcript;
    let isCorrect = false;
    const target = word.word.toLowerCase();

    for (let i = 0; i < results.length; i++) {
      const alt = results[i].transcript.trim().toLowerCase();
      if (alt === target || similarity(alt, target) > 0.7) {
        bestMatch = results[i].transcript;
        isCorrect = true;
        break;
      }
    }

    if (!isCorrect) {
      isCorrect = similarity(transcript.toLowerCase(), target) > 0.7;
    }

    showPronunFeedback(word, bestMatch, isCorrect, confidence);
  };

  recognition.onerror = (event) => {
    resetMicUI();
    const result = document.getElementById('pronun-result');
    if (event.error === 'no-speech') {
      result.innerHTML = '<div class="pronun-error">🤫 Không nghe thấy giọng nói. Thử lại nhé!</div>';
    } else if (event.error === 'not-allowed') {
      result.innerHTML = '<div class="pronun-error">🚫 Cần cấp quyền microphone trong Settings của trình duyệt</div>';
    } else {
      result.innerHTML = `<div class="pronun-error">😅 Lỗi: ${event.error}. Thử lại nhé!</div>`;
    }
  };

  recognition.onend = () => { resetMicUI(); };

  try { recognition.start(); } catch (e) {
    resetMicUI();
    document.getElementById('pronun-result').innerHTML = '<div class="pronun-error">😅 Không khởi động được micro. Thử lại!</div>';
  }
}

function resetMicUI() {
  const micBtn = document.getElementById('pronun-mic');
  const wave = document.getElementById('pronun-wave');
  const micArea = document.getElementById('pronun-mic-area');
  if (micBtn) {
    micBtn.classList.remove('recording');
    micBtn.querySelector('.pronun-mic-label').textContent = 'Bấm để nói';
  }
  if (wave) wave.classList.remove('active');
  if (micArea) micArea.classList.remove('recording');
}

function stopRecognition() {
  if (pronun.recognition) {
    try { pronun.recognition.abort(); } catch (e) {}
    pronun.recognition = null;
  }
}

function showPronunFeedback(word, transcript, isCorrect, confidence) {
  const isZH = word.lang === 'zh';
  const result = document.getElementById('pronun-result');
  const nextBtn = document.getElementById('pronun-next');
  const confidencePct = Math.round((confidence || 0) * 100);

  if (isCorrect) {
    pronun.correct++;
    document.getElementById('pronun-score').textContent = `✅ ${pronun.correct}`;
    SFX.playCorrect();
    result.innerHTML = `
      <div class="pronun-feedback correct">
        <div class="pronun-feedback-icon">✅</div>
        <div class="pronun-feedback-text">Tuyệt vời!</div>
        <div class="pronun-heard">Nghe được: <strong>"${transcript}"</strong></div>
        <div class="pronun-confidence">Độ chính xác: ${confidencePct}%</div>
      </div>
    `;
  } else {
    SFX.playWrong();
    result.innerHTML = `
      <div class="pronun-feedback wrong">
        <div class="pronun-feedback-icon">🔄</div>
        <div class="pronun-feedback-text">Thử lại nhé!</div>
        <div class="pronun-heard">Nghe được: <strong>"${transcript}"</strong></div>
        <div class="pronun-target">Cần nói: <strong>"${word.word}"</strong></div>
        <button class="pronun-retry-btn" id="pronun-retry">🎤 Nói lại</button>
      </div>
    `;
    const retryBtn = document.getElementById('pronun-retry');
    if (retryBtn) retryBtn.addEventListener('click', () => {
      result.innerHTML = '';
      nextBtn.classList.add('hidden');
      startListening(word);
    });
  }

  nextBtn.classList.remove('hidden');
}

function showPronunResults() {
  const body = document.getElementById('pronun-body');
  const pct = Math.round((pronun.correct / pronun.words.length) * 100);
  const emoji = pct >= 80 ? '🏆' : pct >= 60 ? '👏' : pct >= 40 ? '💪' : '🎯';

  body.innerHTML = `
    <div class="pronun-results-card">
      <div class="pronun-results-emoji">${emoji}</div>
      <div class="pronun-results-title">${pct >= 80 ? 'Phát âm tuyệt vời!' : pct >= 60 ? 'Khá tốt!' : 'Tiếp tục luyện tập!'}</div>
      <div class="pronun-results-score">${pronun.correct} / ${pronun.words.length} từ đúng (${pct}%)</div>
      <div class="pronun-results-actions">
        <button class="pronun-retry-all" id="pronun-retry-all">🔄 Luyện lại</button>
        <button class="pronun-back-btn" id="pronun-back">🏠 Về Quiz</button>
      </div>
    </div>
  `;

  document.getElementById('pronun-retry-all').addEventListener('click', () => startPronunciationPractice());
  document.getElementById('pronun-back').addEventListener('click', () => {
    switchTab('quiz-screen');
    loadQuizMenu();
  });
}

// Simple string similarity (Dice coefficient)
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bi = a.substring(i, i + 2);
    bigrams.set(bi, (bigrams.get(bi) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bi = b.substring(i, i + 2);
    const count = bigrams.get(bi) || 0;
    if (count > 0) { bigrams.set(bi, count - 1); hits++; }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

// ─── STATS (Phase 3: real streak + XP) ────────────────
async function loadStats() {
  const stats = await DB.getDailyStats(today());
  document.getElementById('stat-learned').textContent = stats?.words_learned || 0;

  // Real XP
  const xpEl = document.getElementById('stat-xp');
  if (xpEl) xpEl.textContent = stats?.xp_earned || 0;

  // Real streak
  const streak = await DB.getStreak();
  document.getElementById('stat-streak').textContent = streak;
}

// ─── PHASE 4: DASHBOARD ──────────────────────────────
async function loadDashboard() {
  const dash = document.getElementById('stats-dashboard');

  // Gather data
  const allTopicProgress = await DB.getAllTopicProgress();
  const bankCount = await DB.getQuizBankCount();
  const streak = await DB.getStreak();
  const freezeLeft = await DB.getStreakFreezeRemaining();

  const topicsMastered = allTopicProgress.filter(t => t.status === 'mastered').length;
  const totalLearned = allTopicProgress.reduce((sum, t) => sum + t.wordsLearned.length, 0);
  const totalCorrect = allTopicProgress.reduce((sum, t) => sum + t.totalCorrect, 0);
  const totalWrong = allTopicProgress.reduce((sum, t) => sum + t.totalWrong, 0);
  const accuracy = (totalCorrect + totalWrong) > 0 ? Math.round((totalCorrect / (totalCorrect + totalWrong)) * 100) : 0;

  // Last 7 days stats
  const days = [];
  const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const stat = await DB.getDailyStats(dateStr);
    days.push({ date: dateStr, day: dayNames[d.getDay()], learned: stat?.words_learned || 0, xp: stat?.xp_earned || 0, isToday: i === 0 });
  }
  const maxLearned = Math.max(...days.map(d => d.learned), 1);
  const weekTotal = days.reduce((s, d) => s + d.learned, 0);
  const weekXP = days.reduce((s, d) => s + d.xp, 0);

  dash.innerHTML = `
    <!-- Overview Cards -->
    <div class="dash-overview">
      <div class="dash-card dash-card-accent">
        <div class="dash-card-icon">🔥</div>
        <div class="dash-card-value">${streak}</div>
        <div class="dash-card-label">Streak ngày</div>
        <div class="dash-freeze">❄️ ${freezeLeft}/2 freeze</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon">📚</div>
        <div class="dash-card-value">${totalLearned}</div>
        <div class="dash-card-label">Từ đã học</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon">🎯</div>
        <div class="dash-card-value">${accuracy}%</div>
        <div class="dash-card-label">Chính xác</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon">🧠</div>
        <div class="dash-card-value">${bankCount}</div>
        <div class="dash-card-label">Kho ôn tập</div>
      </div>
    </div>

    <!-- Weekly Chart -->
    <div class="dash-section">
      <div class="dash-section-header">
        <span>📈 Tuần này</span>
        <span class="dash-section-badge">${weekTotal} từ • ${weekXP} XP</span>
      </div>
      <div class="dash-chart">
        ${days.map(d => `
          <div class="dash-bar-col">
            <div class="dash-bar-value">${d.learned || ''}</div>
            <div class="dash-bar-wrap"><div class="dash-bar${d.isToday ? ' today' : ''}" style="height:${Math.max(4, (d.learned / maxLearned) * 100)}%"></div></div>
            <div class="dash-bar-label${d.isToday ? ' today' : ''}">${d.day}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Topic Progress -->
    <div class="dash-section">
      <div class="dash-section-header">
        <span>📚 Tiến độ chủ đề</span>
        <span class="dash-section-badge">${topicsMastered}/${TOPICS.filter(t => (t.lang || 'en') === currentLang).length} hoàn thành</span>
      </div>
      ${TOPICS.filter(t => (t.lang || 'en') === currentLang).map(topic => {
        const tp = allTopicProgress.find(t => t.topicName === topic.name);
        const learned = tp ? tp.wordsLearned.length : 0;
        const pct = Math.round((learned / topic.count) * 100);
        const status = tp?.status === 'mastered' ? '🏆' : tp?.status === 'in_progress' ? '📖' : '🔒';
        return `
          <div class="dash-topic-row">
            <span class="dash-topic-icon">${topic.icon}</span>
            <div class="dash-topic-info">
              <div class="dash-topic-name">${topic.name_vi} <span>${status}</span></div>
              <div class="topic-progress-bar"><div class="topic-progress-fill" style="width:${pct}%"></div></div>
            </div>
            <span class="dash-topic-pct">${learned}/${topic.count}</span>
          </div>
        `;
      }).join('')}
    </div>

    <!-- Weekly Report -->
    <div class="dash-section">
      <div class="dash-section-header"><span>📋 Báo cáo tuần</span></div>
      <div class="dash-report">
        <div class="dash-report-row"><span>📚 Từ đã học tuần này</span><strong>${weekTotal}</strong></div>
        <div class="dash-report-row"><span>⭐ XP kiếm được</span><strong>${weekXP}</strong></div>
        <div class="dash-report-row"><span>🏆 Chủ đề hoàn thành</span><strong>${topicsMastered}/${TOPICS.filter(t => (t.lang || 'en') === currentLang).length}</strong></div>
        <div class="dash-report-row"><span>🎯 Tỉ lệ đúng tổng</span><strong>${accuracy}%</strong></div>
        <div class="dash-report-row"><span>❄️ Streak Freeze còn</span><strong>${freezeLeft}/2</strong></div>
      </div>
    </div>

    <!-- Achievements -->
    <div class="dash-section">
      <div class="dash-section-header">
        <span>🏅 Thành tích</span>
        <span class="dash-section-badge">${getUnlockedCount(totalLearned, streak, topicsMastered, bankCount, allTopicProgress)}/${ACHIEVEMENTS.length}</span>
      </div>
      <div class="achievements-grid">
        ${ACHIEVEMENTS.map(a => {
          const val = a.check(totalLearned, streak, topicsMastered, bankCount, allTopicProgress);
          const unlocked = val >= a.target;
          const pct = Math.min(100, Math.round((val / a.target) * 100));
          return `
            <div class="achievement-card${unlocked ? ' unlocked' : ''}">
              <div class="achievement-icon">${unlocked ? a.icon : '🔒'}</div>
              <div class="achievement-info">
                <div class="achievement-name">${a.name}</div>
                <div class="achievement-desc">${a.desc}</div>
                ${!unlocked ? `<div class="topic-progress-bar" style="margin-top:6px"><div class="topic-progress-fill" style="width:${pct}%"></div></div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${val}/${a.target}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ─── ACHIEVEMENTS DEFINITION ────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_word', icon: '📖', name: 'Bước đầu tiên', desc: 'Học 1 từ đầu tiên', target: 1, check: (w) => w },
  { id: 'words_10', icon: '📚', name: 'Mười từ đầu', desc: 'Học đủ 10 từ', target: 10, check: (w) => w },
  { id: 'words_50', icon: '🎓', name: 'Nửa trăm', desc: 'Học đủ 50 từ', target: 50, check: (w) => w },
  { id: 'words_100', icon: '💯', name: 'Bách khoa', desc: 'Học đủ 100 từ', target: 100, check: (w) => w },
  { id: 'words_200', icon: '🌟', name: 'Siêu sao', desc: 'Học đủ 200 từ', target: 200, check: (w) => w },
  { id: 'words_300', icon: '👑', name: 'Vua từ vựng', desc: 'Học hết 300 từ!', target: 300, check: (w) => w },
  { id: 'streak_3', icon: '🔥', name: '3 ngày liên tiếp', desc: 'Streak 3 ngày', target: 3, check: (w, s) => s },
  { id: 'streak_7', icon: '🔥', name: 'Tuần lửa', desc: 'Streak 7 ngày', target: 7, check: (w, s) => s },
  { id: 'streak_30', icon: '🔥', name: 'Tháng lửa', desc: 'Streak 30 ngày!', target: 30, check: (w, s) => s },
  { id: 'topic_1', icon: '🏆', name: 'Chủ đề đầu tiên', desc: 'Hoàn thành 1 chủ đề', target: 1, check: (w, s, t) => t },
  { id: 'topic_5', icon: '🏆', name: 'Nửa chặng đường', desc: 'Hoàn thành 5 chủ đề', target: 5, check: (w, s, t) => t },
  { id: 'boss_1', icon: '🏅', name: 'Chiến binh Boss', desc: 'Pass Boss Quiz đầu tiên', target: 1, check: (w, s, t, b, all) => all.filter(a => a.bossQuizPassed).length },
];

function getUnlockedCount(w, s, t, b, all) {
  return ACHIEVEMENTS.filter(a => a.check(w, s, t, b, all) >= a.target).length;
}

// ─── START ─────────────────────────────────────────────
init();
