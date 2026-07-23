// Speech-to-text for WhatsApp voice notes via Sarvam AI's Saaras model —
// purpose-built for Telugu/Hindi/English code-switched speech (customers
// commonly mix all three mid-sentence), unlike general-purpose Whisper.
// Docs: https://docs.sarvam.ai/api-reference/speech-to-text/transcribe

function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "ogg"; // WhatsApp voice notes are opus/ogg by default
}

/** Transcribe a WhatsApp voice note using Sarvam's Saaras model (codemix mode). */
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not set — cannot transcribe voice notes");

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extensionFor(mimeType)}`);
  form.append("model", "saaras:v3");
  form.append("language_code", "unknown"); // auto-detect Telugu/Hindi/English
  form.append("mode", "codemix"); // tuned for mid-sentence language switching

  const resp = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: form,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Sarvam transcription failed (${resp.status}): ${err}`);
  }

  const result = (await resp.json()) as { transcript: string };
  return result.transcript.trim();
}
