function cleanSection(value: string) {
  return value.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

/** Return the numeric VIDEO block represented by a supported Drive MP4 filename. */
export function driveVideoNumberFromFilename(fileName: string): number {
  const match = fileName.trim().match(/^(?:video_|uzun_video_)(\d+)\.mp4$/i);
  if (!match) throw new Error("Dosya adı video_N.mp4 veya uzun_video_N.mp4 biçiminde olmalı.");
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > 999) {
    throw new Error("Video numarası 1 ile 999 arasında olmalı.");
  }
  return number;
}

export type DriveVideoMetadata = {
  title: string;
  description: string;
  tags: string[];
  pinnedComment: string;
};

/** Parse metadata only from the explicit VIDEO N block in baslik.md; never synthesize missing fields. */
export function readDriveVideoMetadata(markdown: string, videoNumber: number): DriveVideoMetadata {
  if (!Number.isInteger(videoNumber) || videoNumber < 1 || videoNumber > 999) {
    throw new Error("Geçersiz video numarası.");
  }
  const lines = markdown.split(/\r?\n/);
  const sectionHeading = (line: string) =>
    new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:📹\\s*)?VIDEO\\s+0*${videoNumber}\\b`, "i").test(line);
  const start = lines.findIndex(sectionHeading);
  if (start < 0) throw new Error(`baslik.md içinde VIDEO ${videoNumber} bölümü bulunamadı.`);
  let end = lines.findIndex((line, index) => index > start && /^\s*(?:#{1,6}\s*)?(?:📹\s*)?VIDEO\s+\d+\b/i.test(line));
  if (end < 0) end = lines.length;
  const block = lines.slice(start, end).join("\n");
  const read = (labels: string[]) => {
    for (const label of labels) {
      const escaped = label;
      const match = block.match(new RegExp(`(?:^|\\n)\\s*(?:📌|📝|🏷️|💬)?\\s*\\**${escaped}\\**\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:📌|📝|🏷️|💬)?\\s*\\**[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]{2,}\\**\\s*:|$)`, "i"));
      if (match?.[1]?.trim()) return cleanSection(match[1]);
    }
    return "";
  };
  const title = read(["BAŞLIK", "BASLIK"]);
  const description = read(["AÇIKLAMA", "ACIKLAMA"]);
  const tags = read(["ETİKETLER", "ETIKETLER"]).split(/[,\n]/).map((tag) => tag.trim().replace(/^#/, "").trim()).filter(Boolean).slice(0, 30);
  const pinnedComment = read(["SABİT YORUM", "SABIT YORUM"]);
  if (!title) throw new Error(`VIDEO ${videoNumber} için BAŞLIK alanı baslik.md içinde bulunamadı.`);
  return { title: title.replace(/^["'`]|["'`]$/g, "").slice(0, 100), description, tags, pinnedComment };
}
