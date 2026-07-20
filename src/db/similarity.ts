/**
 * String similarity helpers for regulation de-duplication.
 *
 * Regulation names vary in punctuation, casing, and wording across sources,
 * so we compare a normalized form using the Sørensen–Dice coefficient over
 * character bigrams — robust to minor edits and word-order changes.
 */

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Character bigrams of a normalized string (spaces removed). */
function bigrams(s: string): Map<string, number> {
  const clean = s.replace(/\s+/g, "");
  const grams = new Map<string, number>();
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/**
 * Sørensen–Dice coefficient of two names, 0.0–1.0.
 * Returns 1.0 for identical normalized names.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const ga = bigrams(na);
  const gb = bigrams(nb);

  let intersection = 0;
  let totalA = 0;
  let totalB = 0;
  for (const c of ga.values()) totalA += c;
  for (const c of gb.values()) totalB += c;
  for (const [g, countA] of ga) {
    const countB = gb.get(g);
    if (countB) intersection += Math.min(countA, countB);
  }

  return (2 * intersection) / (totalA + totalB);
}

/** Default threshold above which two regulation names are "the same". */
export const NAME_MATCH_THRESHOLD = 0.82;
