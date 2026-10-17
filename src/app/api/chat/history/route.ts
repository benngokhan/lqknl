import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";


export async function GET(req: Request) {
  const authenticated = isMiraSessionCookie(req.headers.get("cookie"));

  if (!authenticated) {
    return NextResponse.json({ error: "Mira oturumu doğrulanmadı." }, { status: 401 });
  }

  try {
    const rows = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .orderBy(desc(messages.id))
      .limit(100);

    const restored = rows
      .reverse()
      .filter(
        (row): row is { role: string; content: string } =>
          (row.role === "user" || row.role === "assistant") &&
          typeof row.content === "string",
      );

    return NextResponse.json(
      { messages: restored },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Mira chat history read failed:", error);
    return NextResponse.json(
      { error: "Sohbet geçmişi veritabanından okunamadı." },
      { status: 500 },
    );
  }
}
