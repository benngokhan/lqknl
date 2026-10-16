// YouTube Data API v3: OAuth2 + resumable video yükleme.
// Bağımsız fetch implementasyonu — googleapis paketi gerektirmez.
// Token kalıcılığı: "integrations" tablosu ("youtube" anahtarı).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
].join(" ");

export type YoutubeTokens = {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number; // epoch ms
  scope?: string;
  channelId?: string | null;
  channelTitle?: string | null;
};

export function youtubeConfig() {
  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
  const baseUrl = (process.env.NEXT_PUBLIC_MIRA_BASE_URL || "https://aimira.up.railway.app").replace(/\/$/, "");
  const redirectUri = `${baseUrl}/api/youtube/auth/callback`;
  return { clientId, clientSecret, baseUrl, redirectUri };
}

export function youtubeStatus(): { configured: boolean; missing: string[] } {
  const { clientId, clientSecret } = youtubeConfig();
  const missing = [
    ...(clientId ? [] : ["YOUTUBE_CLIENT_ID"]),
    ...(clientSecret ? [] : ["YOUTUBE_CLIENT_SECRET"]),
  ];
  return { configured: missing.length === 0, missing };
}

export function buildAuthUrl(state: string) {
  const { clientId, redirectUri } = youtubeConfig();
  const params = new URLSearchParams({
    client_id: clientId || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES,
    access_type: "offline",
    prompt: "consent", // refresh token her seferinde alınsın
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function postTokenForm(body: Record<string, string>) {
  const { clientId, clientSecret } = youtubeConfig();
  if (!clientId || !clientSecret) throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET ayarlı değil");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error_description || data?.error || res.status;
    throw new Error(`Google token işlemi başarısız: ${String(detail).slice(0, 300)}`);
  }
  return data;
}

export async function exchangeCodeForTokens(code: string): Promise<YoutubeTokens> {
  const { redirectUri } = youtubeConfig();
  const data = await postTokenForm({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (!data.refresh_token) {
    throw new Error("Google refresh token vermedi (consent ekranındaki erişimi onaylamış mıydınız?).");
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scope: data.scope,
  };
}

export async function saveYoutubeTokens(tokens: YoutubeTokens) {
  await db.insert(integrations)
    .values({ key: "youtube", value: tokens as unknown as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrations.key,
      set: { value: tokens as unknown as Record<string, unknown>, updatedAt: new Date() },
    });
}

export async function loadYoutubeTokens(): Promise<YoutubeTokens | null> {
  const [row] = await db.select().from(integrations).where(eq(integrations.key, "youtube")).limit(1);
  if (!row?.value || typeof row.value !== "object") return null;
  const value = row.value as Record<string, unknown>;
  if (typeof value.refreshToken !== "string" || !value.refreshToken) return null;
  return value as unknown as YoutubeTokens;
}

async function freshAccessToken(): Promise<string> {
  let tokens = await loadYoutubeTokens();

  // Yedek: env üzerinden tek refresh token
  if (!tokens && process.env.YOUTUBE_REFRESH_TOKEN) {
    tokens = { refreshToken: process.env.YOUTUBE_REFRESH_TOKEN };
  }
  if (!tokens) throw new Error("YouTube bağlantısı yok: önce /api/youtube/auth ile Google hesabını bağla");

  const stillValid = tokens.accessToken && tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt > Date.now() + 60_000;
  if (stillValid && tokens.accessToken) return tokens.accessToken;

  const data = await postTokenForm({
    refresh_token: tokens.refreshToken,
    grant_type: "refresh_token",
  });
  const updated: YoutubeTokens = {
    ...tokens,
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  if (await loadYoutubeTokens()) {
    await saveYoutubeTokens(updated).catch(() => {});
  }
  return data.access_token;
}

export async function getMyChannel(accessToken?: string) {
  const token = accessToken || (await freshAccessToken());
  const res = await fetch(`${CHANNELS_URL}?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Kanal bilgisi alınamadı HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const item = data?.items?.[0];
  if (!item) throw new Error("Bu Google hesabına bağlı YouTube kanalı bulunamadı");
  return { channelId: item.id as string, channelTitle: item.snippet?.title as string };
}

export type UploadInput = {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: "private" | "unlisted" | "public"; // unaudited uygulamada 'public' private kilitlenir
  video: Buffer;
};

export type UploadOutput = {
  videoId: string;
  url: string;
  privacyStatus: string;
};

export async function uploadShort(input: UploadInput): Promise<UploadOutput> {
  const accessToken = await freshAccessToken();
  const privacy = input.privacyStatus || (process.env.YOUTUBE_DEFAULT_PRIVACY as UploadInput["privacyStatus"]) || "private";

  // 1) Resumable oturumu başlat
  const initRes = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(input.video.length),
    },
    body: JSON.stringify({
      snippet: {
        title: input.title.slice(0, 100),
        description: input.description.slice(0, 4900),
        tags: (input.tags || []).slice(0, 30),
        categoryId: process.env.YOUTUBE_CATEGORY_ID || "27", // Education
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!initRes.ok) {
    const detail = (await initRes.text()).slice(0, 500);
    throw new Error(`YouTube yükleme oturumu açılamadı HTTP ${initRes.status}: ${detail}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube yükleme URL'si (Location) dönmedi");

  // 2) Dosyayı yükle
  const body = new ArrayBuffer(input.video.byteLength);
  new Uint8Array(body).set(input.video);
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(input.video.length),
    },
    body,
    signal: AbortSignal.timeout(240_000),
    cache: "no-store",
  });
  const putData = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    const err = putData?.error?.errors?.[0]?.reason || putData?.error?.message || putRes.status;
    throw new Error(`YouTube videos.insert hatası: ${String(err).slice(0, 400)}`);
  }
  const videoId = putData?.id as string;
  if (!videoId) throw new Error("YouTube video ID döndürmedi");
  return { videoId, url: `https://www.youtube.com/shorts/${videoId}`, privacyStatus: privacy };
}


/** Change an already-uploaded video to public only after an explicit Telegram callback. */
export async function makeYoutubeVideoPublic(videoId: string): Promise<{ videoId: string; url: string; privacyStatus: string }> {
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) throw new Error("Geçersiz YouTube video ID");
  const accessToken = await freshAccessToken();
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: videoId, status: { privacyStatus: "public" } }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || data?.error?.errors?.[0]?.reason || `HTTP ${res.status}`;
    throw new Error(`YouTube gizlilik güncellemesi başarısız: ${String(detail).slice(0, 350)}. Gerekirse Google hesabını yeni youtube.force-ssl izniyle yeniden bağla.`);
  }
  const item = data?.items?.[0];
  if (!item?.id || item.status?.privacyStatus !== "public") {
    throw new Error("YouTube herkese açık durumunu doğrulamadı; video gizli kalmış olabilir.");
  }
  return { videoId: item.id, url: `https://www.youtube.com/shorts/${item.id}`, privacyStatus: item.status.privacyStatus };
}
