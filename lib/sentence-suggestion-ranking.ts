const STOP_WORDS = new Set(["about", "after", "among", "because", "between", "could", "different", "during", "from", "have", "however", "into", "more", "most", "other", "over", "particularly", "rather", "results", "such", "than", "that", "their", "there", "these", "this", "those", "through", "under", "using", "were", "when", "where", "which", "while", "with", "within"]);

export function topicWords(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)?.filter((word) => !STOP_WORDS.has(word)) ?? []);
}

export function evidenceScore(claim: string, title: string, abstract = ""): number {
  const words = topicWords(claim);
  if (!words.size) return 0;
  const titleWords = topicWords(title);
  const abstractWords = topicWords(abstract);
  let score = 0;
  for (const word of words) {
    if (titleWords.has(word)) score += 3;
    else if (abstractWords.has(word)) score += 1;
  }
  return score;
}

export function rankByEvidence<T>(items: T[], claim: string, fields: (item: T) => { title: string; abstract?: string }): T[] {
  return items.map((item, index) => ({ item, index, score: evidenceScore(claim, fields(item).title, fields(item).abstract) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}
