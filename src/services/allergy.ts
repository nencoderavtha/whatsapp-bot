import { prisma } from "../db.js";
import { logger } from "./logger.js";

/**
 * Capture allergy and intolerance statements into the customer's notes.
 *
 * This is deliberately not left to the model. An allergy mentioned in passing
 * — "naaku prawns allergy andi" while ordering something else — has to survive
 * the conversation and reach whoever cooks. Relying on the model to notice and
 * call save_customer_info means it is recorded most of the time, and the failure
 * mode of "most of the time" here is someone being served an allergen.
 *
 * Deliberately narrow. Only explicit allergy and intolerance language counts;
 * "no onions" and "less spicy" are preferences and belong to the item note, not
 * to a standing medical flag on the customer. Over-capturing would fill the
 * notes with noise until staff stop reading them, which costs more than it saves.
 */

const ALLERGY_PATTERNS: RegExp[] = [
  /\ballerg(?:y|ic|ies)\b/i,
  /\balergy\b/i, // common misspelling, and common in Tenglish messages
  /\bintoleran(?:t|ce)\b/i,
  /\banaphyla/i,
  /\bpadadu\b/i, // Telugu: "does not suit me", used for foods that make one ill
];

export const ALLERGY_PREFIX = "⚠️ ALLERGY";

export function looksLikeAllergyStatement(text: string): boolean {
  const t = text.trim();
  if (t.length < 4 || t.length > 400) return false;

  // A question about allergens is not a declaration of one. "Does this contain
  // nuts?" must not be filed as "this customer is allergic to nuts".
  if (/\b(does|do|is|are|contains?|any|which|what|unda|undha|unnaya)\b/i.test(t) && /\?$/.test(t)) {
    return false;
  }

  return ALLERGY_PATTERNS.some((p) => p.test(t));
}

/**
 * Record an allergy statement, if the message is one.
 *
 * Appends rather than replaces — a customer may declare a second allergy weeks
 * later, and overwriting would silently drop the first. Repeats are ignored so
 * mentioning the same allergy in three messages does not produce three lines.
 *
 * Returns the note that was added, or null.
 */
export async function captureAllergyNote(
  customerId: number,
  text: string,
): Promise<string | null> {
  try {
    if (!looksLikeAllergyStatement(text)) return null;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { notes: true },
    });
    if (!customer) return null;

    const statement = text.trim().replace(/\s+/g, " ").slice(0, 200);
    const existing = (customer.notes ?? "").trim();

    // Same words already on file, in any casing.
    if (existing.toLowerCase().includes(statement.toLowerCase())) return null;

    const line = `${ALLERGY_PREFIX}: ${statement}`;
    const notes = existing ? `${existing}\n${line}` : line;

    await prisma.customer.update({ where: { id: customerId }, data: { notes } });
    logger.warn(`[allergy] Recorded for customer ${customerId}: ${statement}`);
    return line;
  } catch (e) {
    // Never break the customer's turn. The message is still in the transcript,
    // so nothing is lost silently even if this fails.
    logger.error("[allergy] Could not record the statement:", e);
    return null;
  }
}

/** The allergy lines from a notes field, for the kitchen and the dashboard. */
export function allergyLines(notes?: string | null): string[] {
  if (!notes) return [];
  return notes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(ALLERGY_PREFIX));
}
