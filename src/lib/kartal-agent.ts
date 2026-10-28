/**
 * KartaL tablet-agent köprüsü — panel → tablet komut hattı.
 *
 * Akış:
 *   Panel UI → POST /api/kartal/agent/command  (oturum cookie ile)
 *   Tablet   → GET  /api/kartal/agent/poll?token=…   (5 sn'de bir)
 *   Tablet   → POST /api/kartal/agent/result   (bitince)
 *   Panel UI → GET  /api/kartal/agent/status   (kuyruk + tablet canlılığı)
 *
 * Kuyruk depolaması = mevcut `tasks` tablosu (source='kartal-agent').
 * Şema değişikliği / göç GEREKMEZ.
 */
import { timingSafeEqual } from "node:crypto";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { asc, desc, eq, and } from "drizzle-orm";
import { tasks } from "@/db/schema";

export const AGENT_SOURCE = "kartal-agent";

export const AG = {
  BEKLEMEDE: "BEKLEMEDE",
  CALISIYOR: "CALISIYOR",
  BITTI: "BITTI",
  HATA: "HATA",
} as const;
export type AgentDurum = (typeof AG)[keyof typeof AG];

/**
 * Tablet eşleşme token'ı (384 bit random).
 * Railway'de KARTAL_TABLET_TOKEN env'i tanımlıysa O kazanır (rotasyon = env
 * değişikliği, kod değişikliği yok). Aksi halde aşağıdaki sabit kullanılır;
 * sabit rotasyonu = bu satır + APK yeniden derleme.
 */
const FALLBACK_TOKEN = "1b20e8bf7d96a539f11fbc4915de3f36f7adfd3701a64528";

export function tabletTokenOk(supplied: string | null | undefined): boolean {
  const expected = process.env.KARTAL_TABLET_TOKEN?.trim() || FALLBACK_TOKEN;
  const given = (supplied || "").trim();
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const HEARTBEAT_ACTION = "agent_heartbeat";
/** Tablet bu süreden uzun sessiz kalırsa "çevrimdışı" sayılır. */
export const ONLINE_WINDOW_MS = 10 * 60 * 1000;
/** Kalp atışı logu en az bu aralıklarla yazılır (tablo şişmesin). */
export const HEARTBEAT_LOG_GAP_MS = 5 * 60 * 1000;

/**
 * Tablet canlılık kalp atışı (throttle'lı).
 * Poll/rutin çağrılarda kullanılır; 5 dakikadan sık log yazmaz.
 */
export async function noteHeartbeat(): Promise<{ online: boolean; lastSeen: Date | null }> {
  let lastSeen: Date | null = null;
  const rows = await db
    .select({ createdAt: operations.createdAt })
    .from(operations)
    .where(eq(operations.action, HEARTBEAT_ACTION))
    .orderBy(desc(operations.id))
    .limit(1);
  if (rows[0]) lastSeen = rows[0].createdAt;
  if (!lastSeen || Date.now() - lastSeen.getTime() > HEARTBEAT_LOG_GAP_MS) {
    await db
      .insert(operations)
      .values({ action: HEARTBEAT_ACTION, status: "ok", summary: "KartaL tablet canlı" })
      .catch((err: unknown) => console.error("agent heartbeat yazılamadı:", err));
    lastSeen = new Date();
  }
  return { online: Date.now() - lastSeen.getTime() <= ONLINE_WINDOW_MS, lastSeen };
}

/** Kuyruktaki en eski BEKLEMEDE komutu CALISIYOR olarak işaretle ve döndür. */
export async function claimNextCommand() {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.source, AGENT_SOURCE), eq(tasks.status, AG.BEKLEMEDE)))
    .orderBy(asc(tasks.id))
    .limit(1);
  if (!rows[0]) return null;
  const upd = await db
    .update(tasks)
    .set({ status: AG.CALISIYOR, updatedAt: new Date() })
    .where(and(eq(tasks.id, rows[0].id), eq(tasks.status, AG.BEKLEMEDE)))
    .returning();
  return upd[0] || null;
}

export interface AgentKomutSatir {
  id: number;
  komut: string;
  durum: string;
  sonuc: string | null;
  created_at: string;
  updated_at: string;
}

export function parseAgentNotes(notes: string | null): { sonuc: string | null; hata: string | null } {
  if (!notes) return { sonuc: null, hata: null };
  try {
    const j = JSON.parse(notes) as { sonuc?: string | null; hata?: string | null };
    return { sonuc: j.sonuc ?? null, hata: j.hata ?? null };
  } catch {
    return { sonuc: notes, hata: null };
  }
}

/** Son N agent komutu (yeni → eski). */
export async function listAgentCommands(limit = 15): Promise<AgentKomutSatir[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.source, AGENT_SOURCE))
    .orderBy(desc(tasks.id))
    .limit(limit);
  return rows.map((r) => {
    const parsed = parseAgentNotes(r.notes);
    return {
      id: r.id,
      komut: r.title,
      durum: r.status,
      sonuc: parsed.sonuc || parsed.hata || null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  });
}
