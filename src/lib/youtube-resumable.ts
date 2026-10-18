const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MIN_CHUNK_UNIT = 256 * 1024;

type UploadState =
  | { complete: true; videoId: string; payload: Record<string, unknown> }
  | { complete: false; nextOffset: number };

export type ResumableUploadOptions = {
  uploadUrl: string;
  data: Uint8Array;
  contentType: string;
  chunkSize?: number;
  maxRetries?: number;
  resume?: boolean;
  fetchImpl?: typeof fetch;
};

/**
 * Upload bytes to a Google resumable-upload session in chunks.
 * On ambiguous network/5xx results, query the session before resending bytes.
 */
export async function uploadResumableBytes(options: ResumableUploadOptions): Promise<{ videoId: string }> {
  const { uploadUrl, data, contentType } = options;
  const total = data.byteLength;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxRetries = options.maxRetries ?? 3;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!uploadUrl) throw new Error("Resumable upload URL is missing.");
  if (!total) throw new Error("Cannot upload an empty video.");
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_UNIT || chunkSize % MIN_CHUNK_UNIT !== 0) {
    throw new Error("Resumable upload chunk size must be a positive multiple of 256 KiB.");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 8) {
    throw new Error("Resumable upload maxRetries must be between 0 and 8.");
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextOffsetFromRange = (range: string | null) => {
    const match = range?.match(/^bytes=0-(\d+)$/i);
    return match ? Number(match[1]) + 1 : 0;
  };
  const parseCompleted = async (response: Response): Promise<UploadState> => {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const videoId = typeof payload.id === "string" ? payload.id : "";
    if (!videoId) {
      throw new Error("YouTube upload returned a successful HTTP status without a video ID.");
    }
    return { complete: true, videoId, payload };
  };
  const responseError = async (response: Response) => {
    const text = await response.text().catch(() => "");
    let detail = text.slice(0, 350);
    try {
      const parsed = JSON.parse(text);
      detail = String(parsed?.error?.message || parsed?.error?.errors?.[0]?.reason || detail).slice(0, 350);
    } catch {}
    return new Error("YouTube resumable upload failed HTTP " + response.status + (detail ? ": " + detail : ""));
  };
  const queryStatus = async (): Promise<UploadState> => {
    const response = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Range": "bytes */" + total,
      },
      body: new ArrayBuffer(0),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (response.status === 200 || response.status === 201) return parseCompleted(response);
    if (response.status === 308) return { complete: false, nextOffset: nextOffsetFromRange(response.headers.get("range")) };
    if (response.status === 404 || response.status === 410) {
      throw new Error("YouTube resumable upload session expired or no longer exists; do not blindly create a second upload.");
    }
    throw await responseError(response);
  };

  let offset = 0;
  let retries = 0;
  if (options.resume) {
    const state = await queryStatus();
    if (state.complete) return { videoId: state.videoId };
    offset = Math.min(state.nextOffset, total);
  }

  while (offset < total) {
    const start = offset;
    const endExclusive = Math.min(start + chunkSize, total);
    const chunk = data.subarray(start, endExclusive);
    const body = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(body).set(chunk);

    try {
      const response = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(chunk.byteLength),
          "Content-Range": "bytes " + start + "-" + (endExclusive - 1) + "/" + total,
        },
        body,
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });

      if (response.status === 200 || response.status === 201) {
        const result = await parseCompleted(response);
        if (result.complete) return { videoId: result.videoId };
      }

      if (response.status === 308) {
        const nextOffset = nextOffsetFromRange(response.headers.get("range"));
        if (nextOffset > start) {
          offset = Math.min(nextOffset, total);
          retries = 0;
          continue;
        }
        if (retries >= maxRetries) throw new Error("YouTube upload made no progress after " + (maxRetries + 1) + " attempts.");
        retries += 1;
        await wait(Math.min(1000 * 2 ** (retries - 1), 5000));
        continue;
      }

      if (response.status !== 429 && response.status < 500) throw await responseError(response);
      throw new Error("Retryable YouTube upload response HTTP " + response.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Do not retry permanent API errors; only reconcile transport ambiguity and transient HTTP errors.
      const permanentHttp = /YouTube resumable upload failed HTTP (?!429\b)(4\d\d)\b/.test(message) ||
        /session expired or no longer exists/.test(message);
      if (permanentHttp) throw error;

      try {
        const state = await queryStatus();
        if (state.complete) return { videoId: state.videoId };
        if (state.nextOffset > start) {
          offset = Math.min(state.nextOffset, total);
          retries = 0;
          continue;
        }
      } catch (statusError) {
        const statusMessage = statusError instanceof Error ? statusError.message : String(statusError);
        if (/HTTP (?!429\b)(4\d\d)\b|session expired or no longer exists/.test(statusMessage)) throw statusError;
      }

      if (retries >= maxRetries) {
        throw new Error("YouTube upload failed after retrying and checking session progress: " + message.slice(0, 400));
      }
      retries += 1;
      await wait(Math.min(1000 * 2 ** (retries - 1), 5000));
    }
  }

  // The server may acknowledge every byte with 308 while still finalizing the video.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const state = await queryStatus();
    if (state.complete) return { videoId: state.videoId };
    if (attempt < maxRetries) await wait(Math.min(1000 * 2 ** attempt, 5000));
  }
  throw new Error("YouTube acknowledged all upload bytes but did not return a finalized video ID.");
}
