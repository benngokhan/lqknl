const TENSORART_API_BASE = "https://ap-east-1.tensorart.cloud/v1";

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
    throw new Error(`Tensor.Art API HTTP ${response.status}: ${(data?.message || data?.error || "istek reddedildi").slice(0, 300)}`);
  }
  return parsed;
}

function unwrapJob(value: unknown): TensorArtJob {
  const data = value as TensorArtJob | null;
  return data?.job && typeof data.job === "object" ? data.job : (data ?? {});
}

export async function generateTensorArtImage(prompt: string) {
  const token = process.env.TENSORART_API_KEY?.trim();
  const modelId = process.env.TENSORART_MODEL_ID?.trim();

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
      request_id: crypto.randomUUID(),
      stages: [
        {
          type: "INPUT_INITIALIZE",
          input_initialize: { seed: 0, count: 1 },
        },
        {
          type: "DIFFUSION",
          diffusion: {
            width: 576,
            height: 1024,
            prompts: [{ text: prompt.slice(0, 5000), weight: 1 }],
            negative_prompts: [{ text: "text, lettering, watermark, logo, blurry, low quality", weight: 1 }],
            sd_model: modelId,
            steps: 24,
            cfg_scale: 7,
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
