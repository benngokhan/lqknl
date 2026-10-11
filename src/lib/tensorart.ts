const TENSORART_API_BASE = "https://ap-east-1.tensorart.cloud/v1";

/**
 * Railway'a yapıştırılan anahtarlarda sık görülen hataları temizler:
 * - Çevresindeki tırnaklar ("..." veya '...')
 * - İçine kaçmış boşluk/satır sonu karakterleri
 * - Yanlışlıkla birlikte gelen "Bearer " öneki (başka türlü header "Bearer Bearer ..." olur ve Tensor.Art 400 invalid authorization header döner)
 */
function sanitizeCredential(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  // Önce "Bearer " önekini at (boşluklar silinmeden), sonra içeriye kaçan boşluk/satır sonlarını temizle
  value = value.replace(/^bearer[: ]+/i, "");
  value = value.replace(/\s+/g, "");
  return value || null;
}

type TensorArtImage = { url?: string };
type TensorArtJob = {
  id?: string | number;
  status?: string;
  failedInfo?: { reason?: string; code?: string };
  successInfo?: { images?: TensorArtImage[] };
  job?: TensorArtJob;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Tensor.Art API JSON döndürmedi (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const data = parsed as { message?: string; error?: string };
    const detail = (data?.message || data?.error || "istek reddedildi").slice(0, 300);
    const authHint = /invalid authorization/i.test(detail)
      ? " — TENSORART_API_KEY değerini kontrol et: yalnızca anahtar yapıştırılmalı (tırnak, 'Bearer' öneki veya gizli boşluk olmadan)"
      : "";
    throw new Error(`Tensor.Art API HTTP ${response.status}: ${detail}${authHint}`);
  }
  return parsed;
}

function unwrapJob(value: unknown): TensorArtJob {
  const data = value as TensorArtJob | null;
  return data?.job && typeof data.job === "object" ? data.job : (data ?? {});
}

export async function generateTensorArtImage(prompt: string) {
  const token = sanitizeCredential(process.env.TENSORART_API_KEY);
  const modelId = sanitizeCredential(process.env.TENSORART_MODEL_ID);

  if (!token) throw new Error("TENSORART_API_KEY eksik (Railway Variables)");
  if (!modelId) throw new Error("TENSORART_MODEL_ID eksik (Tensor.Art model ID'si Railway Variables'a eklenmeli)");

  const createResponse = await fetch(`${TENSORART_API_BASE}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      stages: [
        {
          type: "INPUT_INITIALIZE",
          inputInitialize: { seed: 0, count: 1 },
        },
        {
          type: "DIFFUSION",
          diffusion: {
            width: 576,
            height: 1024,
            prompts: [{ text: prompt.slice(0, 5000), weight: 1 }],
            negativePrompts: [{ text: "text, lettering, watermark, logo, blurry, low quality", weight: 1 }],
            sdModel: modelId,
            steps: 24,
            cfgScale: 7,
          },
        },
      ],
      }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });

  const created = unwrapJob(await readJson(createResponse));
  const jobId = created.id;
  if (!jobId) throw new Error("Tensor.Art API iş kimliği döndürmedi");

  for (let attempt = 0; attempt < 30; attempt++) {
    const status = String(created.status || "").toUpperCase();
    if (status === "SUCCESS") {
      const images = created.successInfo?.images ?? [];
      const urls = images.map((image) => image.url).filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url));
      if (!urls.length) throw new Error("Tensor.Art işi başarılı görünüyor ancak görsel URL'si dönmedi");
      return { images: urls.map((url) => ({ url })) };
    }
    if (status === "FAILED" || status === "CANCELED") {
      const reason = created.failedInfo?.reason || created.failedInfo?.code || status;
      throw new Error(`Tensor.Art görsel üretimi başarısız: ${String(reason).slice(0, 250)}`);
    }

    await sleep(2_000);
    const pollResponse = await fetch(`${TENSORART_API_BASE}/jobs/${encodeURIComponent(String(jobId))}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    Object.assign(created, unwrapJob(await readJson(pollResponse)));
  }

  throw new Error("Tensor.Art görsel üretimi 60 saniyede tamamlanmadı; iş kimliği kaybolmadan görev tekrar denenebilir");
}
