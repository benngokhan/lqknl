import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations, tasks } from "@/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import {
  AG,
  AGENT_SOURCE,
  HEARTBEAT_ACTION,
  ONLINE_WINDOW_MS,
  listAgentCommands,
} from "@/lib/kartal-agent";

export const dynamic = "force-dynamic";

const CALISIYOR_ZAMAN_ASIMI_MS = 15 * 60 * 1000;

/**
 * GET /api/kartal/agent/status  — panel UI: kuyruk + tablet canlılığı.
 * Yan iş: 15 dk'dır sonuç gelmeyen CALISIYOR komutları HATA'ya düşürülür
 * (tablet sonucu yazamamışsa kuyruk sonsuza dek takılı kalmasın).
 */
export async function GET(req: Request) {
  if (!isMiraSessionCookie(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }
  const simdi = Date.now();
  await db
    .update(tasks)
    .set({
      status: AG.HATA,
      notes: JSON.stringify({ sonuc: null, hata: "Zaman aşımı: 15 dk içinde sonuç gelmedi" }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.source, AGENT_SOURCE),
        eq(tasks.status, AG.CALISIYOR),
        lt(tasks.updatedAt, new Date(simdi - CALISIYOR_ZAMAN_ASIMI_MS))
      )
    )
    .catch((err: unknown) => console.error("agent timeout taraması:", err));
  const rows = await db
    .select({ createdAt: operations.createdAt })
    .from(operations)
    .where(eq(operations.action, HEARTBEAT_ACTION))
    .orderBy(desc(operations.id))
    .limit(1);
  const lastSeen = rows[0]?.createdAt || null;
  const online = !!lastSeen && Date.now() - lastSeen.getTime() <= ONLINE_WINDOW_MS;

  const komutlar = await listAgentCommands(15);
  const bekleyen = komutlar.filter((k) => k.durum === "BEKLEMEDE" || k.durum === "CALISIYOR").length;

  return NextResponse.json({
    ok: true,
    tablet: { online, last_seen: lastSeen ? lastSeen.toISOString() : null },
    bekleyen,
    komutlar,
  });
}
