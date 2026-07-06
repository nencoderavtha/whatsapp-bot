import "dotenv/config";

function required(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

// AI provider — all OpenAI-compatible, so only baseURL + key + model differ.
// Pick with AI_PROVIDER. If not set, auto-pick the first provider that has a key.
const keys: Record<ProviderName, string> = {
  openrouter: process.env.OPENROUTER_API_KEY ?? "",
  groq: process.env.GROQ_API_KEY ?? "",
  cerebras: process.env.CEREBRAS_API_KEY ?? "",
  gemini: process.env.GEMINI_API_KEY ?? "",
};

// Provider registry
const PROVIDERS = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.0-flash-001",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
  },
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    defaultModel: "gpt-oss-120b",
  },
  gemini: {
    // Native Gemini SDK uses this model name directly.
    baseURL: "",
    defaultModel: "gemini-2.0-flash",
  },
} as const;
type ProviderName = keyof typeof PROVIDERS;

const order: ProviderName[] = ["openrouter", "groq", "cerebras", "gemini"];
const aiProvider =
  (process.env.AI_PROVIDER as ProviderName) || order.find((n) => keys[n]) || "groq";

// If user explicitly set AI_PROVIDER but didn't set the matching key, fail early.
if (process.env.AI_PROVIDER) {
  const selected = aiProvider as ProviderName;
  if (!keys[selected]) {
    throw new Error(
      `AI_PROVIDER=${process.env.AI_PROVIDER} but the matching API key env var is empty. ` +
        `Set GEMINI_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY as needed.`,
    );
  }
}



const AI = PROVIDERS[aiProvider];

export const config = {
  aiProvider,
  aiBaseURL: AI.baseURL,
  aiApiKey: keys[aiProvider],
  aiModel: process.env.AI_MODEL || AI.defaultModel,
  // kept for the "key not set" warnings
  groqApiKey: keys.groq,
  geminiApiKey: keys.gemini,

  // Use local SQLite fallback if DATABASE_URL isn't provided.
  // Prisma CLI/schema may still require env(), so ensure we set it at runtime too.
  databaseUrl: process.env.DATABASE_URL ?? "file:./dev.db",



  adminPort: Number(process.env.PORT ?? process.env.ADMIN_PORT ?? 4000),
  adminPassword: process.env.ADMIN_PASSWORD ?? "changeme",
  jwtSecret: process.env.JWT_SECRET ?? "change-me-in-production",

  whatsappProvider: (process.env.WHATSAPP_PROVIDER ?? "baileys") as "baileys" | "cloud" | "kapso",
  cloud: {
    token: process.env.WHATSAPP_CLOUD_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "my-verify-token",
  },
  kapso: {
    apiKey: process.env.KAPSO_API_KEY ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  },
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${Number(process.env.PORT ?? process.env.ADMIN_PORT ?? 4000)}`,

  restaurantName: process.env.RESTAURANT_NAME ?? "Military Rajamma Hotel",
  restaurantCity: process.env.RESTAURANT_CITY ?? "Hyderabad",
  ownerNumbers: (process.env.OWNER_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
