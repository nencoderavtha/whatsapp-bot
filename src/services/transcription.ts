import Groq, { toFile } from "groq-sdk";

let groqClient: Groq | undefined;

function getClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set — cannot transcribe voice notes");
  if (!groqClient) groqClient = new Groq({ apiKey });
  return groqClient;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "ogg"; // WhatsApp voice notes are opus/ogg by default
}

/** Transcribe a WhatsApp voice note using Groq's hosted Whisper — fast and free-tier friendly. */
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const client = getClient();
  const file = await toFile(buffer, `voice.${extensionFor(mimeType)}`, { type: mimeType });
  const result = await client.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
  });
  return result.text.trim();
}
