import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";

const ENTRY_COOKIE = "mira_entry";

export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const authenticated = cookieHeader
    .split(";")
    .some((part) => part.trim() === `${ENTRY_COOKIE}=1`);

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
