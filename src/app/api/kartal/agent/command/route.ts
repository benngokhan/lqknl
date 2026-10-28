import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations, tasks } from "@/db/schema";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { AG, AGENT_SOURCE } from "@/lib/kartal-agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/kartal/agent/command  — panel UI (oturum cookie) ile komut kuyruğa.
 * Body: { komut: string }
 */
export async function POST(req: Request) {
  if (!isMiraSessionCookie(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const komut = typeof b.komut === "string" ? b.komut.trim() : "";
  if (!komut) return NextResponse.json({ error: "komut gerekli" }, { status: 400 });
  if (komut.length > 300) return NextResponse.json({ error: "Komut en fazla 300 karakter" }, { status: 400 });

  const [row] = await db
    .insert(tasks)
    .values({ title: komut, source: AGENT_SOURCE, status: AG.BEKLEMEDE })
    .returning();
  await db
    .insert(operations)
    .values({
      action: "agent_command_create",
      status: "success",
      summary: `KartaL komutu kuyruğa alındı: ${komut.slice(0, 120)}`,
      metadata: { taskId: row.id },
    })
    .catch(() => {});
  return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
}
