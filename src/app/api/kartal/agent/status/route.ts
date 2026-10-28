import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import {
  HEARTBEAT_ACTION,
  ONLINE_WINDOW_MS,
  listAgentCommands,
} from "@/lib/kartal-agent";

export const dynamic = "force-dynamic";

/**
 * GET /api/kartal/agent/status  — panel UI: kuyruk + tablet canlılığı.
 */
export async function GET(req: Request) {
  if (!isMiraSessionCookie(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }
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
