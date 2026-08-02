import { prisma } from "../db.js";
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";

export interface KnowledgeHit {
  id: number;
  question: string;
  answer: string;
  category: string | null;
  isVerbatim: boolean;
  score: number;
}

/**
 * Words too common to tell two articles apart. Without this, "do you have
 * parking" scores against every article containing "you" and the ranking
 * becomes noise.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "do", "does", "did", "you", "your", "we", "our",
  "i", "me", "my", "can", "could", "would", "will", "have", "has", "any", "and",
  "or", "for", "to", "of", "in", "on", "at", "it", "this", "that", "what",
  "which", "how", "when", "where", "there", "with", "be", "am", "was",
]);

/**
 * Crude singular form, so "peanuts" matches a keyword stored as "peanut".
 *
 * Customers type plurals and whoever writes the article types singulars; without
 * this, "which dishes have nuts" missed a nut allergen article that listed
 * "nut". Deliberately not a real stemmer — it only drops a trailing "s", and
 * leaves "ss" endings alone so "glass" doesn't become "glas".
 */
function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .map(singular);
}

/**
 * A hit below this is treated as no hit.
 *
 * The failure that matters here is not missing an answer — it is confidently
 * giving the wrong one. A customer asking about peanut allergies must not be
 * handed the parking article because both mention "have". Returning nothing
 * lets the caller say "let me check with the kitchen", which is always a safe
 * answer; returning a bad match is not.
 */
const MIN_SCORE = 2;

/**
 * Keyword search over the restaurant's published answers.
 *
 * Scoring is in memory rather than Postgres full-text search. At the tens-to-low
 * -hundreds of articles a restaurant actually writes, an index buys nothing
 * measurable, and this stays debuggable — you can see exactly why an article
 * matched. Everything below is contained in this one function, so swapping in
 * tsvector or embeddings later touches nothing else.
 *
 * Matches on the question are weighted above the answer body: a question is
 * written to be matched, whereas a long answer accumulates incidental words.
 */
export interface RankableArticle {
  id: number;
  question: string;
  answer: string;
  keywords: string;
  category: string | null;
  isVerbatim: boolean;
}

/** Pure ranking, split out from the query so it can be tested without a database. */
export function rankArticles(
  query: string,
  articles: RankableArticle[],
  limit = 3,
): KnowledgeHit[] {
  const words = tokenize(query);
  if (words.length === 0) return [];

  const scored: KnowledgeHit[] = [];

  for (const a of articles) {
    // A published article with no answer written yet would otherwise surface as
    // an empty reply. Treat it as absent.
    const answer = a.answer.trim();
    if (!answer) continue;

    const questionWords = new Set(tokenize(a.question));
    const keywordWords = new Set(tokenize(a.keywords));
    const answerWords = new Set(tokenize(answer));

    let score = 0;
    for (const w of words) {
      if (questionWords.has(w)) score += 3;
      else if (keywordWords.has(w)) score += 3;
      else if (answerWords.has(w)) score += 1;
    }

    if (score >= MIN_SCORE) {
      scored.push({
        id: a.id,
        question: a.question,
        answer,
        category: a.category,
        isVerbatim: a.isVerbatim,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function searchKnowledge(
  query: string,
  restaurantId = DEFAULT_RESTAURANT_ID,
  limit = 3,
): Promise<KnowledgeHit[]> {
  if (tokenize(query).length === 0) return [];

  const articles = await prisma.knowledgeArticle.findMany({
    where: { restaurantId, isPublished: true },
    orderBy: { sortOrder: "asc" },
  });

  return rankArticles(query, articles, limit);
}
