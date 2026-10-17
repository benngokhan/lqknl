/** Explicit phrases required to execute or cancel a prepared YouTube schedule. */
export function isYoutubeScheduleConfirmation(message: string): boolean {
  return /^(?:planı onayla|plani onayla|yüklemeyi onayla|yuklemeyi onayla|onaylıyorum|onayliyorum)$/iu.test(message.trim());
}

export function isYoutubeScheduleCancellation(message: string): boolean {
  return /^(?:planı iptal et|plani iptal et|iptal et|vazgeç|vazgec)$/iu.test(message.trim());
}
