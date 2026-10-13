export type ModelProvider = "openrouter" | "groq" | "openai" | "gemini" | "claude" | "cerebras" | "ollama";

export type ModelTurn = { role: "user" | "assistant"; content: string };

export type ModelRequest = {
  system: string;
  history: ModelTurn[];
  message: string;
  privateMode?: boolean;
};

export type ModelResult = {
  provider: ModelProvider;
  model: string;
  content: string;
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-*]{6,}/g, "sk-***")
    .replace(/AIza[A-Za-z0-9_\-]{10,}/g, "AIza***")
    .replace(/gsk_[A-Za-z0-9]{10,}/g, "gsk_***");
}

async function readError(res: Response): Promise<string> {
  return redactSecrets((await res.text()).slice(0, 800));
}

function recentHistory(history: ModelTurn[]): ModelTurn[] {
  const recent = history.slice(-10).filter((turn) => cleanText(turn.content));
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  return recent;
}

const configuredTimeout = Number(process.env.MODEL_TIMEOUT_MS);
const PROVIDER_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 24000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const maxRetries = 0;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithTimeout(input, init);
    if (response.ok || !isRetryableStatus(response.status) || attempt >= maxRetries) return response;

    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5000)
      : 700 * 2 ** attempt;

    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function historyForChat(request: ModelRequest) {
  return [
    { role: "system", content: request.system },
    ...recentHistory(request.history),
    { role: "user", content: request.message },
  ];
}

function historyForOpenAI(request: ModelRequest) {
  return historyForChat(request);
}

async function callOllama(request: ModelRequest): Promise<ModelResult> {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error("OLLAMA_API_KEY missing");

  const baseUrl = (process.env.OLLAMA_BASE_URL || "https://ollama.com").replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL || "treyleo16/kimi-k3:latest";
  const res = await fetchWithRetry(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages: historyForChat(request), stream: false }),
  });

  if (!res.ok) throw new Error(`Ollama ${model} ${res.status}: ${await readError(res)}`);

  const data = await res.json();
  const content = cleanText(data?.message?.content);
  if (!content) throw new Error("Ollama returned empty content");
  return { provider: "ollama", model, content };
}

async function callGemini(request: ModelRequest): Promise<ModelResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const contents = [
    ...recentHistory(request.history).map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.content }],
    })),
    { role: "user", parts: [{ text: request.message }] },
  ];

  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents,
        generationConfig: { temperature: 0.7 },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${await readError(res)}`);

  const data = await res.json();
  const content = cleanText(
    data?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: unknown }) => cleanText(part.text))
      .filter(Boolean)
      .join("\n"),
  );
  if (!content) throw new Error("Gemini returned empty content");
  return { provider: "gemini", model, content };
}

async function callClaude(request: ModelRequest): Promise<ModelResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const messages = [
    ...recentHistory(request.history).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: request.message },
  ];

  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system: request.system,
      messages,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS) || 1200,
    }),
  });

  if (!res.ok) throw new Error(`Claude ${model} ${res.status}: ${await readError(res)}`);

  const data = await res.json();
  const content = cleanText(
    data?.content?.map((part: { type?: string; text?: unknown }) =>
      part.type === "text" ? cleanText(part.text) : "",
    ).filter(Boolean).join("\n"),
  );
  if (!content) throw new Error("Claude returned empty content");
  return { provider: "claude", model, content };
}


async function callOpenRouter(request: ModelRequest): Promise<ModelResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing");

  // KIRMIZI2206 özel oturumunda istenen OpenRouter modeli kullanılır;
  // normal oturumun OPENROUTER_MODEL ayarı değiştirilmez.
  const model = request.privateMode
    ? "nvidia/nemotron-3-ultra-550b-a55b:free"
    : process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://railway.app",
      "X-Title": process.env.OPENROUTER_APP_NAME || "Mira",
    },
    body: JSON.stringify({
      model,
      messages: historyForOpenAI(request),
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter ${model} ${res.status}: ${await readError(res)}`);

  const data = await res.json();
  const content = cleanText(data?.choices?.[0]?.message?.content);
  if (!content) throw new Error("OpenRouter returned empty content");
  return { provider: "openrouter", model, content };
}

const DEFAULT_GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
];

function getGroqModelOrder(): string[] {
  const configuredList = (process.env.GROQ_MODELS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const configuredSingle = (process.env.GROQ_MODEL || "").trim();
  return [...new Set([
    ...(configuredSingle ? [configuredSingle] : []),
    ...configuredList,
    ...DEFAULT_GROQ_MODELS,
  ])];
}

async function callGroq(request: ModelRequest): Promise<ModelResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY missing");

  const failures: string[] = [];
  for (const model of getGroqModelOrder()) {
    try {
      const res = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: historyForOpenAI(request),
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        const detail = `Groq ${model} ${res.status}: ${await readError(res)}`;
        failures.push(detail);
        console.error("[Mira LLM] Groq model failed; trying next model", { model, status: res.status });
        continue;
      }

      const data = await res.json();
      const content = cleanText(data?.choices?.[0]?.message?.content);
      if (!content) {
        failures.push(`Groq ${model}: empty content`);
        console.error("[Mira LLM] Groq model returned empty content; trying next model", { model });
        continue;
      }
      return { provider: "groq", model, content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`Groq ${model}: ${message}`);
      console.error("[Mira LLM] Groq model request failed; trying next model", { model, error: message });
    }
  }

  throw new Error(`All Groq models failed. Tried: ${getGroqModelOrder().join(" -> ")}. Details: ${failures.join(" | ")}`);
}

async function callOpenAI(request: ModelRequest): Promise<ModelResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: historyForOpenAI(request),
      temperature: 0.7,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI ${model} ${res.status}: ${await readError(res)}`);

  const data = await res.json();
  const content = cleanText(data?.choices?.[0]?.message?.content);
  if (!content) throw new Error("OpenAI returned empty content");
  return { provider: "openai", model, content };
}

async function callCerebras(): Promise<ModelResult> {
  throw new Error("Cerebras provider is not configured");
}

const providers: Record<ModelProvider, (request: ModelRequest) => Promise<ModelResult>> = {
  openrouter: callOpenRouter,
  groq: callGroq,
  gemini: callGemini,
  claude: callClaude,
  openai: callOpenAI,
  ollama: callOllama,
  cerebras: callCerebras,
};

// Provider priority requested for Mira: OpenRouter first, Groq second, then Gemini and Ollama backups.
const DEFAULT_PROVIDER_ORDER: ModelProvider[] = ["groq", "openrouter", "gemini", "ollama"];
const ALLOWED_PROVIDER_ORDER = new Set<ModelProvider>(["openrouter", "groq", "gemini", "ollama"]);

function getProviderOrder(): ModelProvider[] {
  const configured = (process.env.MODEL_PROVIDER_ORDER || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is ModelProvider => ALLOWED_PROVIDER_ORDER.has(value as ModelProvider));

  // Keep the requested priority fixed: Groq first, OpenRouter second.
  // Remaining providers are backups if the first two fail.
  return DEFAULT_PROVIDER_ORDER;
}

export async function generateWithFallback(request: ModelRequest): Promise<ModelResult> {
  // KIRMIZI2206 modunda OpenRouter ve istenen Nemotron modeli ilk sırada denenir.
  // Model/sağlayıcı erişilemezse diğer sağlayıcılar yedek olarak kullanılabilir.
  const failures: string[] = [];
  const providerOrder = request.privateMode
    ? (["openrouter", ...getProviderOrder().filter((provider) => provider !== "openrouter")] as ModelProvider[])
    : getProviderOrder();

  for (const provider of providerOrder) {
    try {
      const result = await providers[provider](request);
      console.info("[Mira LLM] provider success", { provider: result.provider, model: result.model });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${provider}: ${message}`);
      console.error("[Mira LLM] provider failed", { provider, error: message });
    }
  }

  throw new Error(`All configured LLM providers failed. Order: ${getProviderOrder().join(" -> ")}. Details: ${failures.join(" | ")}`);
}
