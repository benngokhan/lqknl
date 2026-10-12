import * as XLSX from "xlsx";

export interface PlanRow {
  title: string;
  topic: string;
  hashtags: string;
  category: string;
}

/**
 * "Bilgi Dozu" içerik planı xlsx dosyasını kuyruk kayıtlarına çevrilecek satırlara dönüştürür.
 * Beklenen kolonlar: Video Başlığı, Konu/Kategori, Hook (İlk 3 sn), Senaryo Özeti, Hashtag'ler
 */
export function parsePlanXlsx(buf: Buffer): PlanRow[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  const out: PlanRow[] = [];
  for (const row of rows) {
    const title = String(row["Video Başlığı"] ?? "").trim().slice(0, 300);
    const category = String(row["Konu/Kategori"] ?? "").trim();
    const hook = String(row["Hook (İlk 3 sn)"] ?? "").trim();
    const summary = String(row["Senaryo Özeti"] ?? "").trim();
    const hashtags = String(row["Hashtag'ler"] ?? "").trim();
    if (!title) continue;
    const topic = [
      category,
      title,
      hook ? `Kanca fikri: ${hook}` : "",
      summary ? `Senaryo özeti: ${summary}` : "",
    ].filter(Boolean).join(" — ").slice(0, 500);
    out.push({ title, topic, hashtags, category });
  }
  return out;
}
