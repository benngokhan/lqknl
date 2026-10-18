// YouTube Data API v3: OAuth2 + resumable video yükleme.
// Bağımsız fetch implementasyonu — googleapis paketi gerektirmez.
// Token kalıcılığı: "integrations" tablosu ("youtube" anahtarı).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { compareYoutubeTags, normalizeYoutubeTag } from "@/lib/youtube-tag-verification";
import { uploadResumableBytes } from "@/lib/youtube-resumable";
import { compareYoutubeUploadMetadata, type ExpectedYoutubeUpload, type YoutubeVideoSnapshot } from "@/lib/youtube-upload-verification";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";

// Avoid repeating identical channel/video reads when multiple Mira screens or workflows
// request the same data close together. Writes invalidate this short-lived cache.
const CHANNEL_VIDEO_CACHE_TTL_MS = 60_000;
type ChannelVideoListResult = { channelId: string; channelTitle: string; videos: ChannelVideo[] };
const channelVideoListCache = new Map<number, { expiresAt: number; value: ChannelVideoListResult }>();
const channelVideoListInFlight = new Map<number, Promise<ChannelVideoListResult>>();

export function invalidateYoutubeVideoListCache() {
  channelVideoListCache.clear();
}

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

/**
 * Refreshes an access token and asks Google's tokeninfo endpoint for the
 * actual granted scopes. Never returns or logs the access/refresh token.
 */
export async function debugYoutubeOAuth(): Promise<{
  uploadScopeGranted: boolean;
  scopes: string[];
}> {
  const accessToken = await freshAccessToken();

  const response = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(accessToken),
    {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(data?.error_description || data?.error || "Google tokeninfo error").slice(0, 250);
    throw new Error("Google tokeninfo doğrulaması başarısız HTTP " + response.status + ": " + detail);
  }

  const scopes = typeof data?.scope === "string"
    ? data.scope.split(/\s+/).filter(Boolean)
    : [];

  return {
    uploadScopeGranted: scopes.includes("https://www.googleapis.com/auth/youtube.upload"),
    scopes,
  };
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

export type ChannelVideo = {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  publishedAt: string | null;
  privacyStatus: string | null;
  url: string;
};

/** Read the authenticated channel's uploads playlist, including private videos owned by this account. */
async function fetchMyChannelVideosUncached(maxVideos: number): Promise<ChannelVideoListResult> {
  const token = await freshAccessToken();
  const limit = Math.max(1, Math.min(500, Math.floor(maxVideos)));
  const channelResponse = await fetch(`${CHANNELS_URL}?part=snippet,contentDetails&mine=true`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const channelData = await channelResponse.json().catch(() => ({}));
  if (!channelResponse.ok) {
    throw new Error(`YouTube kanal listesi alınamadı HTTP ${channelResponse.status}: ${String(channelData?.error?.message || "API hatası").slice(0, 250)}`);
  }
  const channel = channelData?.items?.[0];
  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!channel?.id || !uploadsPlaylistId) throw new Error("YouTube kanalının yüklenen videolar listesi bulunamadı.");

  const ids: string[] = [];
  let pageToken = "";
  while (ids.length < limit) {
    const params = new URLSearchParams({
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, limit - ids.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`YouTube video listesi alınamadı HTTP ${response.status}: ${String(data?.error?.message || "API hatası").slice(0, 250)}`);
    for (const item of data?.items || []) {
      const id = item?.contentDetails?.videoId;
      if (typeof id === "string" && id) ids.push(id);
    }
    pageToken = typeof data?.nextPageToken === "string" ? data.nextPageToken : "";
    if (!pageToken || !(data?.items || []).length) break;
  }

  const videos: ChannelVideo[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const params = new URLSearchParams({ part: "snippet,status", id: ids.slice(offset, offset + 50).join(","), maxResults: "50" });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`YouTube video ayrıntıları alınamadı HTTP ${response.status}: ${String(data?.error?.message || "API hatası").slice(0, 250)}`);
    for (const item of data?.items || []) {
      if (typeof item?.id !== "string") continue;
      videos.push({
        videoId: item.id,
        title: String(item.snippet?.title || ""),
        description: String(item.snippet?.description || ""),
        tags: Array.isArray(item.snippet?.tags) ? item.snippet.tags.filter((tag: unknown): tag is string => typeof tag === "string") : [],
        categoryId: typeof item.snippet?.categoryId === "string" ? item.snippet.categoryId : null,
        publishedAt: typeof item.snippet?.publishedAt === "string" ? item.snippet.publishedAt : null,
        privacyStatus: typeof item.status?.privacyStatus === "string" ? item.status.privacyStatus : null,
        url: `https://www.youtube.com/watch?v=${item.id}`,
      });
    }
  }
  return { channelId: channel.id, channelTitle: String(channel.snippet?.title || ""), videos };
}

/** Return a short-lived cached list and coalesce concurrent identical reads. */
export async function listMyChannelVideos(maxVideos = 200): Promise<ChannelVideoListResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(maxVideos)));
  const now = Date.now();
  const cached = channelVideoListCache.get(limit);
  if (cached && cached.expiresAt > now) return cached.value;

  const pending = channelVideoListInFlight.get(limit);
  if (pending) return pending;

  const request = fetchMyChannelVideosUncached(limit)
    .then((value) => {
      channelVideoListCache.set(limit, { expiresAt: Date.now() + CHANNEL_VIDEO_CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => channelVideoListInFlight.delete(limit));
  channelVideoListInFlight.set(limit, request);
  return request;
}

export type UploadInput = {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: "private" | "unlisted" | "public"; // unaudited uygulamada 'public' private kilitlenir
  publishAt?: string; // ISO timestamp; future private scheduled upload only
  video: Buffer;
  /** Existing session URL for recovery; never expose it to clients. */
  uploadSessionUrl?: string;
  /** Persist a newly-created session before sending any video bytes. */
  onUploadSession?: (uploadUrl: string) => Promise<void>;
};

export type UploadOutput = {
  videoId: string;
  url: string;
  privacyStatus: string;
};

export async function uploadShort(input: UploadInput): Promise<UploadOutput> {
  const accessToken = await freshAccessToken();
  const privacy = input.privacyStatus || (process.env.YOUTUBE_DEFAULT_PRIVACY as UploadInput["privacyStatus"]) || "private";
  const uploadTags: string[] = [];
  const seenTags = new Set<string>();
  for (const rawTag of input.tags || []) {
    const tag = rawTag.trim();
    const key = normalizeYoutubeTag(tag);
    if (tag && key && !seenTags.has(key)) {
      seenTags.add(key);
      uploadTags.push(tag);
      if (uploadTags.length === 30) break;
    }
  }
  if (uploadTags.some((tag) => tag.length > 100) || uploadTags.join(",").length > 500) {
    throw new Error("YouTube etiket sınırları aşılıyor: en fazla 30 etiket, her biri 100 karakter ve ayraçlarla toplam 500 karakter.");
  }

  // Reuse a persisted session during recovery; otherwise create and persist a new one.
  let uploadUrl = input.uploadSessionUrl;
  if (!uploadUrl) {
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
          tags: uploadTags,
          categoryId: process.env.YOUTUBE_CATEGORY_ID || "27", // Education
        },
        status: {
          privacyStatus: input.publishAt ? "private" : privacy,
          ...(input.publishAt ? { publishAt: input.publishAt } : {}),
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
    const newUploadUrl = initRes.headers.get("location");
    if (!newUploadUrl) throw new Error("YouTube yükleme URL'si (Location) dönmedi");
    uploadUrl = newUploadUrl;
    // Persist the session before sending bytes, so a restarted request can reconcile it.
    await input.onUploadSession?.(uploadUrl);
  }

  // 2) Upload the video in resumable chunks and reconcile ambiguous responses before retrying bytes.
  const uploaded = await uploadResumableBytes({
    uploadUrl,
    data: input.video,
    contentType: "video/mp4",
    resume: Boolean(input.uploadSessionUrl),
  });
  const videoId = uploaded.videoId;
  const effectivePrivacy = input.publishAt ? "private" : privacy;
  invalidateYoutubeVideoListCache();
  return { videoId, url: `https://www.youtube.com/shorts/${videoId}`, privacyStatus: effectivePrivacy };
}


/** Verify the final YouTube resource by reading it back; never infer success from upload HTTP status alone. */
export async function verifyYoutubeVideo(
  videoId: string,
  expected: ExpectedYoutubeUpload,
): Promise<{ videoId: string; verified: true }> {
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) throw new Error("Geçersiz YouTube video ID");
  const accessToken = await freshAccessToken();
  const delays = [500, 1000, 2000, 3000, 5000];
  let lastMismatch = "video is not visible through videos.list yet";

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=" + encodeURIComponent(videoId),
      {
        headers: { Authorization: "Bearer " + accessToken },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < delays.length) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      throw new Error("YouTube yükleme sonrası doğrulama isteği başarısız HTTP " + response.status + ": " +
        String(data?.error?.message || "API hatası").slice(0, 300));
    }

    const item = data?.items?.[0];
    if (item?.id === videoId && item?.snippet && item?.status) {
      const actual: YoutubeVideoSnapshot = {
        title: String(item.snippet.title || ""),
        description: String(item.snippet.description || ""),
        tags: Array.isArray(item.snippet.tags)
          ? item.snippet.tags.filter((tag: unknown): tag is string => typeof tag === "string")
          : [],
        privacyStatus: String(item.status.privacyStatus || ""),
        ...(typeof item.status.publishAt === "string" ? { publishAt: item.status.publishAt } : {}),
      };
      const comparison = compareYoutubeUploadMetadata(expected, actual);
      if (comparison.matches) return { videoId, verified: true };
      lastMismatch = comparison.mismatches.join(", ");
    }

    if (attempt < delays.length) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }

  throw new Error("YouTube video yüklendi ancak son metaveri doğrulaması başarısız: " + lastMismatch);
}


/** Add a top-level comment to a video. YouTube's public Data API does not expose pin/unpin operations. */
export async function addYoutubeComment(videoId: string, text: string): Promise<{ commentId: string }> {
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) throw new Error("Geçersiz YouTube video ID");
  const cleanText = text.trim().slice(0, 10000);
  if (!cleanText) throw new Error("Yorum metni boş.");
  const accessToken = await freshAccessToken();
  const response = await fetch("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: {
        videoId,
        topLevelComment: { snippet: { textOriginal: cleanText } },
      },
    }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`YouTube yorum eklenemedi HTTP ${response.status}: ${String(data?.error?.message || "API hatası").slice(0, 300)}`);
  }
  const commentId = data?.snippet?.topLevelComment?.id || data?.id;
  if (typeof commentId !== "string" || !commentId) throw new Error("YouTube yorum kimliği döndürmedi.");
  return { commentId };
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
  invalidateYoutubeVideoListCache();
  return { videoId: item.id, url: `https://www.youtube.com/shorts/${item.id}`, privacyStatus: item.status.privacyStatus };
}


/** Replace tags only, preserving the video's current title, description, category and publication status. */
export async function updateYoutubeVideoTags(videoId: string, tags: string[]): Promise<{ videoId: string; tags: string[]; verified: true }> {
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) throw new Error("Geçersiz YouTube video ID");
  const cleanTags: string[] = [];
  const seenTags = new Set<string>();
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const key = normalizeYoutubeTag(tag);
    if (tag && key && !seenTags.has(key)) {
      seenTags.add(key);
      cleanTags.push(tag);
      if (cleanTags.length === 30) break;
    }
  }
  if (cleanTags.some((tag) => tag.length > 100) || cleanTags.join(",").length > 500) {
    throw new Error("Etiketler YouTube sınırlarını aşıyor (en fazla 30 etiket ve toplam 500 karakter).");
  }

  const accessToken = await freshAccessToken();
  const getVideo = async () => {
    const response = await fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=" + encodeURIComponent(videoId), {
      headers: { Authorization: "Bearer " + accessToken },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("YouTube video bilgisi alınamadı HTTP " + response.status + ": " + String(data?.error?.message || "API hatası").slice(0, 250));
    const item = data?.items?.[0];
    if (!item?.id || !item?.snippet) throw new Error("YouTube videos.get mevcut videoyu döndürmedi.");
    return item;
  };

  const current = await getVideo();
  const snippet = current.snippet;
  const payload = {
    id: videoId,
    snippet: {
      title: String(snippet.title || ""),
      description: String(snippet.description || ""),
      categoryId: String(snippet.categoryId || "27"),
      ...(typeof snippet.defaultLanguage === "string" ? { defaultLanguage: snippet.defaultLanguage } : {}),
      ...(typeof snippet.defaultAudioLanguage === "string" ? { defaultAudioLanguage: snippet.defaultAudioLanguage } : {}),
      tags: cleanTags,
    },
  };

  const writeTags = async () => {
    const response = await fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet", {
      method: "PUT",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error("YouTube etiket güncellemesi başarısız HTTP " + response.status + ": " + String(result?.error?.message || "API hatası").slice(0, 300));
    }
  };

  // YouTube's videos.update can become visible to videos.list/get after a short propagation delay.
  // Avoid immediately treating a stale read as a failed write.
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Compare normalized tag sets so YouTube casing/order differences do not cause false failures.
  const readBack = async () => {
    const item = await getVideo();
    const actual = Array.isArray(item.snippet?.tags)
      ? item.snippet.tags.filter((tag: unknown): tag is string => typeof tag === "string")
      : [];
    return { actual, ...compareYoutubeTags(cleanTags, actual) };
  };

  // Poll for propagation first. A successful PUT should not be repeated until the
  // first write has had enough time to become visible through videos.list/get.
  const pollForMatch = async (delays: number[]) => {
    let result = await readBack();
    for (const delay of delays) {
      if (result.matches) break;
      await wait(delay);
      result = await readBack();
    }
    return result;
  };

  await writeTags();
  let verification = await pollForMatch([500, 1000, 2000, 3000]);

  // If the read-back remains stale, retry the idempotent update once and poll again.
  if (!verification.matches) {
    await writeTags();
    verification = await pollForMatch([1000, 2000, 3000, 5000]);
  }

  if (!verification.matches) {
    const actual = verification.actual;
    const missing = verification.missing;
    const unexpected = verification.unexpected;
    throw new Error(
      "YouTube güncelleme isteğini kabul etti ancak yeniden okuma doğrulaması başarısız. " +
      "Beklenen etiket: " + cleanTags.length + ", okunan: " + actual.length +
      (missing.length ? "; eksik: " + missing.slice(0, 8).join(", ") : "") +
      (unexpected.length ? "; beklenmeyen: " + unexpected.slice(0, 8).join(", ") : "")
    );
  }

  invalidateYoutubeVideoListCache();
  return { videoId, tags: verification.actual, verified: true };
}
