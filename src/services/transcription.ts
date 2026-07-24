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

// Telugu Unicode block — used as a hard backstop after transliteration.
const TELUGU_SCRIPT = /[ఀ-౿]/;

/**
 * Transcribe a WhatsApp voice note using Sarvam's Saaras model in TRANSLIT
 * mode — the transcript is romanized (e.g. "...ఎంత?" → "...enta?").
 *
 * This is deliberate: the bot mirrors the SCRIPT of the customer's message, so
 * if a voice transcript carried native Telugu script, the bot would start
 * replying in Telugu Unicode. Voice input must always come back as Roman
 * Telugu/English so it never triggers that — keyboard-typed Telugu script from
 * the customer is unaffected and still mirrored normally.
 */
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not set — cannot transcribe voice notes");

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extensionFor(mimeType)}`);
  form.append("model", "saaras:v3");
  form.append("language_code", "unknown"); // auto-detect Telugu/Hindi/English
  form.append("mode", "translit"); // romanize output — never emit native script from voice

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
  const transcript = result.transcript.trim();

  // Backstop: if translit somehow still returns Telugu script, log it so we
  // notice — the caller (session-manager) treats a voice note conservatively.
  if (TELUGU_SCRIPT.test(transcript)) {
    console.warn(`[Voice] translit still returned Telugu script: "${transcript}"`);
  }
  return transcript;
}
