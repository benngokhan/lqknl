/** Parse an explicit Turkish date and two to four publication times in Europe/Istanbul. */
export function requestedScheduleSlots(text: string, now = new Date()): string[] | null {
  const months: Record<string, string> = {
    ocak: "01", şubat: "02", subat: "02", mart: "03", nisan: "04", mayıs: "05", mayis: "05",
    haziran: "06", temmuz: "07", ağustos: "08", agustos: "08", eylül: "09", eylul: "09",
    ekim: "10", kasım: "11", kasim: "11", aralık: "12", aralik: "12",
  };
  const dateMatch = text.match(/\b(\d{1,2})\s+(ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)\s+(20\d{2})\b/iu);
  if (!dateMatch) return null;
  const day = Number(dateMatch[1]);
  const monthText = dateMatch[2].toLocaleLowerCase("tr-TR");
  const month = months[monthText];
  const year = Number(dateMatch[3]);
  const validDate = new Date(Date.UTC(year, Number(month) - 1, day));
  if (!month || validDate.getUTCFullYear() !== year || validDate.getUTCMonth() !== Number(month) - 1 || validDate.getUTCDate() !== day) return null;

  const remainder = text.slice((dateMatch.index || 0) + dateMatch[0].length);
  const times = [...remainder.matchAll(/\b(\d{1,2})[.:](\d{2})\b/g)].slice(0, 5);
  if (times.length < 2 || times.length > 4) return null;

  const slots: string[] = [];
  for (const match of times) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    const iso = `${year}-${month}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+03:00`;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime() + 60_000) return null;
    slots.push(date.toISOString());
  }
  if (new Set(slots).size !== slots.length) return null;
  if (slots.some((slot, index) => index > 0 && new Date(slot).getTime() <= new Date(slots[index - 1]).getTime())) return null;
  return slots;
}
