/**
 * Classic ELIZA pronoun reflection mappings.
 */
const REFLECTION_MAP: Record<string, string> = {
  "i": "you",
  "me": "you",
  "my": "your",
  "mine": "yours",
  "myself": "yourself",
  "you": "I",
  "your": "my",
  "yours": "mine",
  "yourself": "myself",
  "am": "are",
  "are": "am",
  "was": "were",
  "were": "was",
  "i'm": "you are",
  "im": "you are",
  "you're": "I am",
  "youre": "I am",
  "i've": "you have",
  "ive": "you have",
  "you've": "I have",
  "youve": "I have",
  "i'll": "you will",
  "ill": "you will",
  "you'll": "I will",
  "youll": "I will",
  "i'd": "you would",
  "you'd": "I would",
};

/**
 * Reflects pronouns in a captured phrase to provide natural conversational reflection.
 * Uses a single-pass token replacement to prevent double-reflection.
 */
export function reflectPronouns(text: string): string {
  if (!text || text.trim() === "") return "";

  // Split into tokens preserving word boundaries and punctuation
  const tokenRegex = /\b[\w']+\b|[^\w\s]+|\s+/g;
  const matches = text.match(tokenRegex) || [];

  const reflectedTokens = matches.map((token) => {
    const lower = token.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(REFLECTION_MAP, lower)) {
      const replacement = REFLECTION_MAP[lower]!;
      if (replacement === "i") return "I";
      return replacement;
    }
    return token;
  });

  let result = reflectedTokens.join("").trim();
  // Clean up any trailing punctuation
  result = result.replace(/[.?!,;:]+$/, "").trim();
  return result;
}
