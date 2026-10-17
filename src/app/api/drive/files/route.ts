import { NextResponse } from "next/server";
import { listDriveFolderFiles } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  }
  try {
    const files = await listDriveFolderFiles();
    return NextResponse.json({ ok: true, count: files.length, files });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 400) }, { status: 502 });
  }
}
