// Aynı başlıklı içerik kopyalarını bulmak için saf yardımcılar.
// Türkçe duyarlı normalize: "Ahtapotlar çevrelerini nasıl algılar?" ile
// "ahtapotlar çevrelerini nasıl algılar?" aynı anahtara düşer.
export function normalizeTitleKey(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("tr-TR");
}

export type ContentRowLike = { id: number; title: string | null };

/**
 * Satırları normalize başlığa göre gruplar; her grupta en yüksek id'li (en yeni)
 * kaydı korur, kalanları `duplicates` olarak döndürür. Başlıksız/anahtarsız satırlar
 * hiçbir zaman kopya sayılmaz.
 */
export function splitDuplicateRows<T extends ContentRowLike>(rows: T[]): { keep: T[]; duplicates: T[] } {
  const bestByKey = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeTitleKey(row.title);
    if (!key) continue;
    const best = bestByKey.get(key);
    if (best === undefined || row.id > best) bestByKey.set(key, row.id);
  }
  const keep: T[] = [];
  const duplicates: T[] = [];
  for (const row of rows) {
    const key = normalizeTitleKey(row.title);
    if (key && bestByKey.get(key) !== row.id) duplicates.push(row);
    else keep.push(row);
  }
  return { keep, duplicates };
}
