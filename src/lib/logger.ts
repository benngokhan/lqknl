import { db } from "@/db";
import { operations } from "@/db/schema";

/**
 * Mira olay günlüğü — kalıcılık `operations` tablosunda (action="mira_log").
 * Aynı satır ayrıca console'a yansır → Railway panelinde de görünür, paneldeki
 * /logs sayfasından da takip edilir. Log ASLA çağıran akışı patlatmaz.
 */

export type LogLevel = "info" | "success" | "warn" | "error";

const STATUS_MAP: Record<LogLevel, string> = {
  info: "success",
  success: "success",
  warn: "warn",
  error: "failed",
};

export const LOG_ACTION = "mira_log";

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function logEvent(input: {
  level?: LogLevel;
  source: string;
  message: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const level = input.level ?? "info";
  const line = `[MİRA/${input.source}] ${input.message}`;

  // Railway log paneli aynası
  if (level === "error") console.error(line, input.meta ?? "");
  else if (level === "warn") console.warn(line, input.meta ?? "");
  else console.log(line);

  try {
    let metaObj: Record<string, unknown> = {};
    if (input.meta) {
      let metaText = JSON.stringify(input.meta) ?? "";
      if (metaText.length > 2000) metaText = metaText.slice(0, 2000);
      metaObj = JSON.parse(metaText) as Record<string, unknown>;
    }
    await db.insert(operations).values({
      action: LOG_ACTION,
      status: STATUS_MAP[level],
      summary: input.message.slice(0, 400),
      platform: input.source,
      metadata: { level, ...metaObj },
    });
  } catch (error) {
    console.error("[MİRA/log] kayıt yazılamadı:", errText(error));
  }
}
