import "dotenv/config";

function required(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

// AI provider — all OpenAI-compatible, so only baseURL + key + model differ.
// Pick with AI_PROVIDER, else auto-pick the first one that has a key.
const keys: Record<ProviderName, string> = {
  openrouter: process.env.OPENROUTER_API_KEY ?? "",
  groq: process.env.GROQ_API_KEY ?? "",
  cerebras: process.env.CEREBRAS_API_KEY ?? "",
};

const PROVIDERS = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    // gpt-4o-mini gives the most natural Telugu + reliable ordering at low cost.
    // Alternatives with good Telugu: google/gemini-2.5-flash, openai/gpt-4o.
    defaultModel: "openai/gpt-4o-mini",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
  },
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    defaultModel: "gpt-oss-120b",
  },
} as const;
type ProviderName = keyof typeof PROVIDERS;

const order: ProviderName[] = ["openrouter", "groq", "cerebras"];
const aiProvider =
  (process.env.AI_PROVIDER as ProviderName) || order.find((n) => keys[n]) || "groq";
const AI = PROVIDERS[aiProvider];

export const config = {
  aiProvider,
  aiBaseURL: AI.baseURL,
  aiApiKey: keys[aiProvider],
  aiModel: process.env.AI_MODEL || AI.defaultModel,
  // kept for the "key not set" warnings
  groqApiKey: keys.groq,

  databaseUrl: required("DATABASE_URL", "file:./dev.db"),

  adminPort: Number(process.env.ADMIN_PORT ?? 4000),
  adminPassword: process.env.ADMIN_PASSWORD ?? "changeme",

  whatsappProvider: (process.env.WHATSAPP_PROVIDER ?? "baileys") as "baileys" | "cloud",
  cloud: {
    token: process.env.WHATSAPP_CLOUD_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "my-verify-token",
  },

  restaurantName: process.env.RESTAURANT_NAME ?? "Military Rajamma Hotel",
  restaurantCity: process.env.RESTAURANT_CITY ?? "Hyderabad",
  ownerNumbers: (process.env.OWNER_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
