import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { uploadDriveFile } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

const MAX_FILE_BYTES = 250 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "video/mp4",
  "text/markdown",
  "text/plain",
  "application/json",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Form-data içinde 'file' dosyası gerekli." }, { status: 400 });
    }
    if (file.size < 1 || file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: "Dosya boş veya 250 MB sınırını aşıyor." }, { status: 413 });
    }
    const mimeType = file.type || "application/octet-stream";
    if (!ALLOWED_TYPES.has(mimeType)) {
      return NextResponse.json({ ok: false, error: "Desteklenmeyen dosya türü. MP4, Markdown, TXT, JSON, JPG, PNG veya WebP yüklenebilir." }, { status: 415 });
    }
    const result = await uploadDriveFile({
      name: file.name,
      mimeType,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, uploaded: result, folderId: process.env.DRIVE_FOLDER_ID });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive yükleme hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 500) }, { status: 502 });
  }
}
