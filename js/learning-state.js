export async function filterHomeDailyEntries(entries, getWord, lang) {
  const filtered = [];

  for (const entry of entries) {
    const isHomeEntry = entry.source === 'home' || !entry.topicName;
    if (!isHomeEntry) continue;

    if (entry.lang && entry.lang !== lang) continue;

    const word = await getWord(entry.wordId);
    if (!word) continue;

    if ((word.lang || 'en') === lang) filtered.push(entry);
  }

  return filtered;
}

export function selectDailyWordIds(existingEntries, allWordIds, count) {
  const existingIds = existingEntries.map(entry => entry.wordId);
  if (existingIds.length >= count) return existingIds.slice(0, count);

  const fillIds = allWordIds
    .filter(id => !existingIds.includes(id))
    .slice(0, count - existingIds.length);
  return [...existingIds, ...fillIds];
}

export function getTopicWordDisplayState(word, topicProgress, batchIndex) {
  const currentBatch = topicProgress?.currentBatch ?? 0;
  const wordsLearned = topicProgress?.wordsLearned || [];
  const isUnlocked = batchIndex <= currentBatch;
  const isLearned = wordsLearned.includes(word.id);

  return {
    isUnlocked,
    isLearned,
    shouldRevealMeaning: isUnlocked && isLearned,
  };
}
