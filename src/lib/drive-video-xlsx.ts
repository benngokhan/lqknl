import * as XLSX from "xlsx";

export type DriveSpreadsheetVideoMetadata = {
  status: string;
  fileName: string;
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  pinnedComment: string;
  category: string;
  source: string;
};

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9]+/g, "");
}

function cell(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key))) return String(value ?? "").trim();
  }
  return "";
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, 30);
}

/** Read the row matching Dosya Adı from the actual Drive baslik.xlsx workbook. */
export function readDriveSpreadsheetMetadata(data: Buffer, fileName: string): DriveSpreadsheetVideoMetadata {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, { type: "buffer", cellDates: false });
  } catch {
    throw new Error("baslik.xlsx dosyası Excel çalışma kitabı olarak okunamadı.");
  }
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    const matching = rows.filter((row) =>
      cell(row, ["Dosya Adı", "Dosya Adi", "Dosya Adı (File Name)"]).toLocaleLowerCase("tr-TR") === fileName.toLocaleLowerCase("tr-TR")
    );
    if (matching.length > 1) throw new Error(`baslik.xlsx içinde ${fileName} için birden fazla satır var.`);
    if (!matching.length) continue;

    const row = matching[0];
    const title = cell(row, ["Video Başlık", "Video Baslik", "Başlık", "Baslik"]);
    if (!title) throw new Error(`baslik.xlsx içinde ${fileName} satırının Video Başlık alanı boş.`);
    const hashtags = splitList(cell(row, ["Hashtag'ler", "Hashtagler", "Hashtags"]));
    const descriptionBase = cell(row, ["Açıklama", "Aciklama", "Description"]);
    const hashtagText = hashtags.map((tag) => `#${tag}`).join(" ");
    const description = hashtagText && !hashtags.every((tag) => descriptionBase.includes(`#${tag}`))
      ? [descriptionBase, hashtagText].filter(Boolean).join("\n\n")
      : descriptionBase;

    return {
      status: cell(row, ["Durum", "Status"]),
      fileName,
      title: title.slice(0, 100),
      description,
      hashtags,
      tags: splitList(cell(row, ["Etiketler", "Tags", "Etiket"])),
      pinnedComment: cell(row, ["Sabit Yorum", "Sabit Yorum Metni", "Pinned Comment"]),
      category: cell(row, ["Konu/Kategori", "Konu", "Kategori", "Category"]),
      source: cell(row, ["Kaynak", "Source"]),
    };
  }
  throw new Error(`Drive klasöründeki baslik.xlsx içinde ${fileName} adlı dosyayla eşleşen satır bulunamadı.`);
}

export function readDriveSpreadsheetCatalog(data: Buffer) {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, { type: "buffer", cellDates: false });
  } catch {
    throw new Error("baslik.xlsx dosyası Excel çalışma kitabı olarak okunamadı.");
  }
  const result: DriveSpreadsheetVideoMetadata[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    for (const row of rows) {
      const fileName = cell(row, ["Dosya Adı", "Dosya Adi", "Dosya Adı (File Name)"]);
      const title = cell(row, ["Video Başlık", "Video Baslik", "Başlık", "Baslik"]);
      if (!fileName || !/^(?:video_\d+|uzun_video_\d+)\.mp4$/i.test(fileName) || !title) continue;
      try {
        result.push(readDriveSpreadsheetMetadata(data, fileName));
      } catch {
        // The catalog should still report valid rows when one row has a problem.
      }
    }
    if (result.length) break;
  }
  return result;
}
