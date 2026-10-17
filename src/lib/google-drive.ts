// Google Drive OAuth and read-only file access for Mira.
// Intentionally separate from src/lib/youtube.ts and the "youtube" integration token.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

export type DriveTokens = {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  scope?: string;
};

export function driveConfig() {
  const clientId = process.env.DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.DRIVE_CLIENT_SECRET?.trim();
  const baseUrl = (process.env.NEXT_PUBLIC_MIRA_BASE_URL || "https://aimira.up.railway.app").replace(/\/$/, "");
  const redirectUri = `${baseUrl}/api/drive/auth/callback`;
  return { clientId, clientSecret, baseUrl, redirectUri };
}

export function driveStatus(): { configured: boolean; missing: string[]; redirectUri: string } {
  const config = driveConfig();
  const missing = [
    ...(config.clientId ? [] : ["DRIVE_CLIENT_ID"]),
    ...(config.clientSecret ? [] : ["DRIVE_CLIENT_SECRET"]),
  ];
  return { configured: missing.length === 0, missing, redirectUri: config.redirectUri };
}

export function buildDriveAuthUrl(state: string) {
  const { clientId, redirectUri } = driveConfig();
  const params = new URLSearchParams({
    client_id: clientId || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function postTokenForm(body: Record<string, string>) {
  const { clientId, clientSecret } = driveConfig();
  if (!clientId || !clientSecret) throw new Error("DRIVE_CLIENT_ID / DRIVE_CLIENT_SECRET tanımlı değil");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Drive token işlemi başarısız: ${String(data?.error_description || data?.error || response.status).slice(0, 250)}`);
  }
  return data;
}

export async function exchangeDriveCode(code: string): Promise<DriveTokens> {
  const { redirectUri } = driveConfig();
  const data = await postTokenForm({ code, grant_type: "authorization_code", redirect_uri: redirectUri });
  if (!data.refresh_token) {
    throw new Error("Google yenileme anahtarı vermedi. İzin ekranını yeniden açıp erişimi tekrar onaylayın.");
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope,
  };
}

export async function saveDriveTokens(tokens: DriveTokens) {
  await db.insert(integrations)
    .values({ key: "google_drive", value: tokens as unknown as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrations.key,
      set: { value: tokens as unknown as Record<string, unknown>, updatedAt: new Date() },
    });
}

export async function loadDriveTokens(): Promise<DriveTokens | null> {
  const [row] = await db.select().from(integrations).where(eq(integrations.key, "google_drive")).limit(1);
  if (!row?.value || typeof row.value !== "object") return null;
  const value = row.value as Record<string, unknown>;
  if (typeof value.refreshToken !== "string" || !value.refreshToken) return null;
  return value as unknown as DriveTokens;
}

async function getDriveAccessToken(): Promise<string> {
  const tokens = await loadDriveTokens();
  if (!tokens) throw new Error("Google Drive bağlı değil. Önce /api/drive/auth adresinden bağlayın.");
  if (tokens.accessToken && tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt > Date.now() + 60_000) {
    return tokens.accessToken;
  }
  const data = await postTokenForm({ refresh_token: tokens.refreshToken, grant_type: "refresh_token" });
  const updated: DriveTokens = {
    ...tokens,
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  await saveDriveTokens(updated);
  return data.access_token as string;
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

export async function listDriveFolderFiles(folderId = process.env.DRIVE_FOLDER_ID?.trim()): Promise<DriveFile[]> {
  if (!folderId) throw new Error("DRIVE_FOLDER_ID değişkenine Mira/video klasör kimliği eklenmemiş.");
  const token = await getDriveAccessToken();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  // Bound pagination so an unexpectedly large folder cannot cause an unbounded request.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      pageSize: "100",
      orderBy: "name",
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Drive klasörü okunamadı HTTP ${response.status}: ${String(data?.error?.message || "Google Drive API hatası").slice(0, 250)}`);
    }
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return files;
}

export async function downloadDriveFile(fileId: string): Promise<{ name: string; mimeType: string; data: Buffer }> {
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(fileId)) throw new Error("Geçersiz Google Drive dosya kimliği.");
  const token = await getDriveAccessToken();
  const metadataResponse = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=name,mimeType`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok) throw new Error(`Drive dosya bilgisi alınamadı HTTP ${metadataResponse.status}`);
  const fileResponse = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
    cache: "no-store",
  });
  if (!fileResponse.ok) throw new Error(`Drive dosyası indirilemedi HTTP ${fileResponse.status}`);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  return { name: String(metadata.name || fileId), mimeType: String(metadata.mimeType || "application/octet-stream"), data: bytes };
}
