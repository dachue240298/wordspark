// IndexedDB wrapper for WordSpark PWA
import { filterHomeDailyEntries, selectDailyWordIds } from './learning-state.js';

const DB_NAME = 'enlight';
const DB_VERSION = 2;
let dbInstance = null;

export async function openDB() {
  if (dbInstance) return dbInstance;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('words')) {
        const ws = db.createObjectStore('words', { keyPath: 'id', autoIncrement: true });
        ws.createIndex('topic', 'topic');
        ws.createIndex('level', 'level');
      }
      if (!db.objectStoreNames.contains('progress')) {
        const ps = db.createObjectStore('progress', { keyPath: 'wordId' });
        ps.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('dailyWords')) {
        const dw = db.createObjectStore('dailyWords', { keyPath: 'id', autoIncrement: true });
        dw.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('dailyStats')) {
        db.createObjectStore('dailyStats', { keyPath: 'date' });
      }
      // ─── Phase 3: New stores ───
      if (!db.objectStoreNames.contains('topicProgress')) {
        const tp = db.createObjectStore('topicProgress', { keyPath: 'topicName' });
        tp.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('quizBank')) {
        const qb = db.createObjectStore('quizBank', { keyPath: 'wordId' });
        qb.createIndex('topicName', 'topicName');
        qb.createIndex('wrongCount', 'wrongCount');
      }
    };
    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function tx(store, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(store, mode).objectStore(store);
}

function req2p(r) { return new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }

// ─── Words ───
export async function getWordCount() {
  const s = await tx('words');
  return req2p(s.count());
}

export async function clearWords() {
  const s = await tx('words', 'readwrite');
  return req2p(s.clear());
}

export async function addWords(words, startIndex = 1) {
  const db = await openDB();
  const t = db.transaction('words', 'readwrite');
  const s = t.objectStore('words');
  for (let i = 0; i < words.length; i++) {
    const w = { ...words[i], id: startIndex + i };
    s.put(w);
  }
  return new Promise((ok, no) => { t.oncomplete = ok; t.onerror = no; });
}

export async function getWord(id) {
  const s = await tx('words');
  return req2p(s.get(id));
}

export async function getAllWordIds() {
  const s = await tx('words');
  return req2p(s.getAllKeys());
}

// Get all word IDs filtered by language
export async function getAllWordIdsByLanguage(lang) {
  const s = await tx('words');
  const allWords = await req2p(s.getAll());
  return allWords.filter(w => w.lang === lang).map(w => w.id);
}

// Get all words filtered by language
export async function getAllWordsByLanguage(lang) {
  const s = await tx('words');
  const allWords = await req2p(s.getAll());
  return allWords.filter(w => w.lang === lang);
}

export async function getWordsByTopic(topicName) {
  const s = await tx('words');
  const idx = s.index('topic');
  return req2p(idx.getAll(topicName));
}

// ─── Progress ───
export async function initProgress(wordId) {
  const s = await tx('progress', 'readwrite');
  const existing = await req2p(s.get(wordId));
  if (!existing) {
    s.add({ wordId, status: 'new', easeFactor: 2.5, interval: 0, repetitions: 0, timesCorrect: 0, timesWrong: 0 });
  }
}

export async function getProgress(wordId) {
  const s = await tx('progress');
  return req2p(s.get(wordId));
}

export async function updateProgress(wordId, correct) {
  const s = await tx('progress', 'readwrite');
  let p = await req2p(s.get(wordId));
  if (!p) p = { wordId, status: 'new', easeFactor: 2.5, interval: 0, repetitions: 0, timesCorrect: 0, timesWrong: 0 };

  if (correct) {
    p.timesCorrect++;
    p.repetitions++;
    p.interval = p.repetitions === 1 ? 1 : p.repetitions === 2 ? 6 : Math.round(p.interval * p.easeFactor);
    p.easeFactor = Math.min(p.easeFactor + 0.1, 3.0);
  } else {
    p.timesWrong++;
    p.repetitions = 0;
    p.interval = 1;
    p.easeFactor = Math.max(p.easeFactor - 0.2, 1.3);
  }
  p.status = (p.timesCorrect >= 5 && p.repetitions >= 3) ? 'mastered' : p.repetitions > 0 ? 'learning' : 'review';
  p.lastReviewed = new Date().toISOString();
  s.put(p);
  return p;
}

// ─── Daily Words ───
export async function getDailyWords(date) {
  const db = await openDB();
  const s = db.transaction('dailyWords').objectStore('dailyWords');
  const idx = s.index('date');
  return req2p(idx.getAll(date));
}

export async function getHomeDailyWords(date, lang) {
  const existing = await getDailyWords(date);
  return filterHomeDailyEntries(existing, getWord, lang);
}

export async function replaceHomeDailyWords(date, wordIds, lang) {
  const existing = await getHomeDailyWords(date, lang);
  const db = await openDB();
  const t = db.transaction('dailyWords', 'readwrite');
  const s = t.objectStore('dailyWords');

  for (const entry of existing) s.delete(entry.id);
  for (const wordId of wordIds) {
    s.add({ wordId, date, shownCount: 0, isLearned: false, source: 'home', lang });
  }

  await new Promise((ok, no) => { t.oncomplete = ok; t.onerror = no; });
  return getHomeDailyWords(date, lang);
}

export async function generateDailyWords(date, count = 10, lang = 'en') {
  const existing = await getHomeDailyWords(date, lang);
  if (existing.length === count) return existing;

  const allIds = (await getAllWordIdsByLanguage(lang)).sort(() => Math.random() - 0.5);
  const selectedIds = selectDailyWordIds(existing, allIds, count);
  return replaceHomeDailyWords(date, selectedIds, lang);
}

export async function markDailyWord(id, learned) {
  const s = await tx('dailyWords', 'readwrite');
  const entry = await req2p(s.get(id));
  if (entry) { entry.isLearned = learned; s.put(entry); }
}

const DEFAULTS = {
  notification_enabled: 'true', notification_interval: '30',
  daily_word_count: '10', pronunciation_mode: 'en',
  quiet_hours_start: '22:00', quiet_hours_end: '07:00',
  streak_freeze_remaining: '2', streak_freeze_week: '',
  learning_language: '', // '' = not chosen yet, 'en' = English, 'zh' = Chinese
};

// ─── Language Helpers ───
export async function getLanguage() {
  return await getSetting('learning_language') || '';
}

export async function setLanguage(lang) {
  await setSetting('learning_language', lang);
}

export async function getSetting(key) {
  const s = await tx('settings');
  const r = await req2p(s.get(key));
  return r ? r.value : DEFAULTS[key] || null;
}

export async function setSetting(key, value) {
  const s = await tx('settings', 'readwrite');
  s.put({ key, value });
}

export async function initSettings() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const existing = await getSetting(k);
    if (existing === null || existing === undefined) await setSetting(k, v);
  }
}

// ─── Daily Stats ───
export async function incrementStat(date, field) {
  const s = await tx('dailyStats', 'readwrite');
  let stats = await req2p(s.get(date));
  if (!stats) stats = { date, words_learned: 0, words_reviewed: 0, notifications_shown: 0, xp_earned: 0 };
  stats[field] = (stats[field] || 0) + 1;
  s.put(stats);
}

export async function addXP(date, amount) {
  const s = await tx('dailyStats', 'readwrite');
  let stats = await req2p(s.get(date));
  if (!stats) stats = { date, words_learned: 0, words_reviewed: 0, notifications_shown: 0, xp_earned: 0 };
  stats.xp_earned = (stats.xp_earned || 0) + amount;
  s.put(stats);
}

export async function getDailyStats(date) {
  const s = await tx('dailyStats');
  return req2p(s.get(date));
}

export async function getAllDailyStats() {
  const s = await tx('dailyStats');
  return req2p(s.getAll());
}

// ─── Phase 3: Topic Progress ───
// Tracks per-topic learning: which batch (0,1,2), which words unlocked, carry-over wrong words

export async function getTopicProgress(topicName) {
  const s = await tx('topicProgress');
  return req2p(s.get(topicName));
}

export async function getAllTopicProgress() {
  const s = await tx('topicProgress');
  return req2p(s.getAll());
}

export async function initTopicProgress(topicName) {
  const s = await tx('topicProgress', 'readwrite');
  const existing = await req2p(s.get(topicName));
  if (!existing) {
    s.put({
      topicName,
      status: 'not_started',   // not_started | in_progress | mastered
      currentBatch: 0,         // 0, 1, 2 (each batch = 10 words)
      wordsLearned: [],        // word IDs that were answered correctly
      wrongCarryOver: [],      // word IDs wrong yesterday → retry today
      lastStudyDate: null,     // last date user studied this topic
      completedDate: null,     // date when topic was mastered
      totalCorrect: 0,
      totalWrong: 0,
    });
  }
  return getTopicProgress(topicName);
}

export async function updateTopicProgress(topicName, updates) {
  const s = await tx('topicProgress', 'readwrite');
  let tp = await req2p(s.get(topicName));
  if (!tp) tp = await initTopicProgress(topicName);
  // Re-fetch after init since initTopicProgress uses a different transaction
  if (!tp) {
    const s2 = await tx('topicProgress');
    tp = await req2p(s2.get(topicName));
  }
  const s3 = await tx('topicProgress', 'readwrite');
  Object.assign(tp, updates);
  s3.put(tp);
  return tp;
}

// ─── Phase 3: Quiz Bank ───
// Words that have been learned go here for SRS-based review quizzing

export async function addToQuizBank(wordId, topicName) {
  const s = await tx('quizBank', 'readwrite');
  const existing = await req2p(s.get(wordId));
  if (!existing) {
    s.put({
      wordId,
      topicName,
      correctCount: 0,
      wrongCount: 0,
      lastQuizzed: null,
      addedDate: new Date().toISOString(),
    });
  }
}

export async function updateQuizBankWord(wordId, correct) {
  const s = await tx('quizBank', 'readwrite');
  const entry = await req2p(s.get(wordId));
  if (!entry) return;
  if (correct) entry.correctCount++;
  else entry.wrongCount++;
  entry.lastQuizzed = new Date().toISOString();
  s.put(entry);
}

export async function getQuizBankAll() {
  const s = await tx('quizBank');
  return req2p(s.getAll());
}

export async function getQuizBankCount() {
  const s = await tx('quizBank');
  return req2p(s.count());
}

// Smart quiz: weight words by wrong count (more wrong = more likely to appear)
export async function getSmartQuizWords(count = 10) {
  const all = await getQuizBankAll();
  if (all.length === 0) return [];

  // Weight: base 1 + wrongCount * 3 - correctCount * 0.5 (min 0.5)
  const weighted = all.map(entry => ({
    ...entry,
    weight: Math.max(0.5, 1 + entry.wrongCount * 3 - entry.correctCount * 0.5)
  }));

  // Weighted random selection
  const selected = [];
  const pool = [...weighted];
  const pickCount = Math.min(count, pool.length);

  for (let i = 0; i < pickCount; i++) {
    const totalWeight = pool.reduce((sum, w) => sum + w.weight, 0);
    let rand = Math.random() * totalWeight;
    let picked = pool[0];
    for (const item of pool) {
      rand -= item.weight;
      if (rand <= 0) { picked = item; break; }
    }
    selected.push(picked);
    pool.splice(pool.indexOf(picked), 1);
  }

  return selected;
}

// ─── Phase 3: Streak with Freeze ───

// Get list of dates that have been frozen (persisted)
async function getFrozenDates() {
  const raw = await getSetting('streak_frozen_dates');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function addFrozenDate(dateStr) {
  const dates = await getFrozenDates();
  if (!dates.includes(dateStr)) {
    dates.push(dateStr);
    // Keep only last 30 days of freeze history
    const recent = dates.slice(-30);
    await setSetting('streak_frozen_dates', JSON.stringify(recent));
  }
}

// Check if a date was active (learned words) or frozen
async function isDayActive(dateStr, allStats) {
  const stat = allStats.find(s => s.date === dateStr);
  if (stat && stat.words_learned > 0) return 'active';

  const frozenDates = await getFrozenDates();
  if (frozenDates.includes(dateStr)) return 'frozen';

  return 'gap';
}

export async function getStreak() {
  const allStats = await getAllDailyStats();
  if (allStats.length === 0) return 0;

  // Sort by date descending
  allStats.sort((a, b) => b.date.localeCompare(a.date));

  const todayStr = new Date().toISOString().split('T')[0];
  let streak = 0;
  let checkDate = new Date(todayStr);

  // Check today first
  const todayStatus = await isDayActive(todayStr, allStats);
  if (todayStatus === 'active') {
    streak = 1;
  } else if (todayStatus === 'frozen') {
    // Frozen today — streak maintained but not incremented
    // We still count it as a streak day to keep continuity
    streak = 1;
  } else {
    // Today has no activity and not frozen yet
    // Check if we could auto-freeze today (don't auto-consume, just be lenient)
    // The streak starts from yesterday if today isn't done yet
    const yesterdayDate = new Date(checkDate);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().split('T')[0];
    const yesterdayStatus = await isDayActive(yesterdayStr, allStats);
    if (yesterdayStatus === 'gap') {
      return 0; // Neither today nor yesterday has activity
    }
    // Yesterday was active/frozen — start counting from yesterday
  }

  // Check previous days going backwards
  for (let d = 1; d <= 365; d++) {
    const prev = new Date(checkDate);
    prev.setDate(prev.getDate() - d);
    const dateStr = prev.toISOString().split('T')[0];

    const status = await isDayActive(dateStr, allStats);
    if (status === 'active') {
      streak++;
    } else if (status === 'frozen') {
      // Frozen day — streak continues but doesn't increment
      // (the freeze "covers" this gap day)
      continue;
    } else {
      // True gap — streak breaks here
      break;
    }
  }

  return streak;
}

// Auto-freeze: called when app detects yesterday was missed
// Returns true if freeze was successfully applied
export async function autoFreezeYesterday() {
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  // Check if yesterday already has activity or is already frozen
  const allStats = await getAllDailyStats();
  const yesterdayStatus = await isDayActive(yesterdayStr, allStats);
  if (yesterdayStatus !== 'gap') return false; // No need to freeze

  // Check if we already checked today
  const lastAutoFreeze = await getSetting('last_auto_freeze_check');
  if (lastAutoFreeze === todayStr) return false; // Already checked today
  await setSetting('last_auto_freeze_check', todayStr);

  // Try to use a freeze
  const success = await useStreakFreeze();
  if (success) {
    await addFrozenDate(yesterdayStr);
    return true;
  }
  return false;
}

export async function useStreakFreeze() {
  const weekKey = getWeekKey();
  const currentWeek = await getSetting('streak_freeze_week');
  let remaining = parseInt(await getSetting('streak_freeze_remaining') || '2');

  // Reset freeze count for new week
  if (currentWeek !== weekKey) {
    remaining = 2;
    await setSetting('streak_freeze_week', weekKey);
    await setSetting('streak_freeze_remaining', '2');
  }

  if (remaining <= 0) return false;

  remaining--;
  await setSetting('streak_freeze_remaining', String(remaining));
  return true;
}

export async function getStreakFreezeRemaining() {
  const weekKey = getWeekKey();
  const currentWeek = await getSetting('streak_freeze_week');

  if (currentWeek !== weekKey) {
    await setSetting('streak_freeze_week', weekKey);
    await setSetting('streak_freeze_remaining', '2');
    return 2;
  }

  return parseInt(await getSetting('streak_freeze_remaining') || '2');
}

function getWeekKey() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${weekNum}`;
}

// ─── Phase 3: Topic daily words generation ───
export async function generateTopicDailyWords(topicName, date, allTopicWords) {
  // Check if already generated for today
  const existing = await getDailyWords(date);
  const topicDaily = existing.filter(dw => dw.topicName === topicName);
  if (topicDaily.length > 0) return topicDaily;

  let tp = await getTopicProgress(topicName);
  if (!tp) tp = await initTopicProgress(topicName);
  // Re-fetch
  tp = await getTopicProgress(topicName);

  // If already mastered, no new daily words
  if (tp.status === 'mastered') return [];

  // Get current batch words (batch 0 = words 0-9, batch 1 = 10-19, batch 2 = 20-29)
  const batchStart = tp.currentBatch * 10;
  const batchEnd = Math.min(batchStart + 10, allTopicWords.length);
  const batchWords = allTopicWords.slice(batchStart, batchEnd);

  // Add carry-over wrong words from previous batch
  const carryOverWords = [];
  for (const wid of tp.wrongCarryOver) {
    const w = allTopicWords.find(w => w.id === wid);
    if (w && !batchWords.find(bw => bw.id === wid)) carryOverWords.push(w);
  }

  const allBatchWords = [...carryOverWords, ...batchWords];

  // Create daily entries
  const db = await openDB();
  const t = db.transaction('dailyWords', 'readwrite');
  const s = t.objectStore('dailyWords');

  for (const word of allBatchWords) {
    const entry = {
      wordId: word.id,
      date,
      shownCount: 0,
      isLearned: false,
      topicName,
      isCarryOver: tp.wrongCarryOver.includes(word.id),
    };
    s.add(entry);
  }

  await new Promise((ok, no) => { t.oncomplete = ok; t.onerror = no; });

  // Update topic progress
  if (tp.status === 'not_started') {
    await updateTopicProgress(topicName, { status: 'in_progress', lastStudyDate: date });
  } else {
    await updateTopicProgress(topicName, { lastStudyDate: date });
  }

  // Re-fetch
  const refreshed = await getDailyWords(date);
  return refreshed.filter(dw => dw.topicName === topicName);
}

// Complete a topic batch: check answers, advance batch or mark mastered
export async function completeTopicBatch(topicName, results, allTopicWords) {
  // results: [{wordId, correct: bool}, ...]
  let tp = await getTopicProgress(topicName);
  if (!tp) return;

  const wrongWordIds = results.filter(r => !r.correct).map(r => r.wordId);
  const correctWordIds = results.filter(r => r.correct).map(r => r.wordId);

  // Update learned words
  const newLearned = [...new Set([...tp.wordsLearned, ...correctWordIds])];
  const totalCorrect = tp.totalCorrect + correctWordIds.length;
  const totalWrong = tp.totalWrong + wrongWordIds.length;

  // Add correct words to quiz bank
  for (const wid of correctWordIds) {
    await addToQuizBank(wid, topicName);
  }

  const nextBatch = tp.currentBatch + 1;
  const maxBatch = Math.ceil(allTopicWords.length / 10);

  if (nextBatch >= maxBatch && wrongWordIds.length === 0) {
    // Topic mastered!
    await updateTopicProgress(topicName, {
      status: 'mastered',
      currentBatch: nextBatch,
      wordsLearned: newLearned,
      wrongCarryOver: [],
      totalCorrect,
      totalWrong,
      completedDate: new Date().toISOString().split('T')[0],
    });
  } else if (nextBatch >= maxBatch) {
    // All batches done but still have wrong words → keep last batch, carry over wrongs
    await updateTopicProgress(topicName, {
      wordsLearned: newLearned,
      wrongCarryOver: wrongWordIds,
      totalCorrect,
      totalWrong,
    });
  } else {
    // Advance to next batch, carry over wrong words
    await updateTopicProgress(topicName, {
      currentBatch: nextBatch,
      wordsLearned: newLearned,
      wrongCarryOver: wrongWordIds,
      totalCorrect,
      totalWrong,
    });
  }

  return getTopicProgress(topicName);
}
