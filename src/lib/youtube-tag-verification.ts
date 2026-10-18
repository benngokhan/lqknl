/** Normalize YouTube tags for comparison; YouTube may reorder or normalize casing. */
export function normalizeYoutubeTag(tag: string): string {
  return tag.normalize("NFKC").toLocaleLowerCase("tr-TR").trim();
}

export type YoutubeTagComparison = {
  matches: boolean;
  missing: string[];
  unexpected: string[];
};

/** Compare tag sets rather than arrays so ordering and duplicate spellings do not create false failures. */
export function compareYoutubeTags(expectedTags: string[], actualTags: string[]): YoutubeTagComparison {
  const expectedByKey = new Map<string, string>();
  for (const tag of expectedTags) {
    const key = normalizeYoutubeTag(tag);
    if (key && !expectedByKey.has(key)) expectedByKey.set(key, tag);
  }

  const actualByKey = new Map<string, string>();
  for (const tag of actualTags) {
    const key = normalizeYoutubeTag(tag);
    if (key && !actualByKey.has(key)) actualByKey.set(key, tag);
  }

  const missing = [...expectedByKey.entries()]
    .filter(([key]) => !actualByKey.has(key))
    .map(([, tag]) => tag);
  const unexpected = [...actualByKey.entries()]
    .filter(([key]) => !expectedByKey.has(key))
    .map(([, tag]) => tag);

  return { matches: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
