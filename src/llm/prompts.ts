export const SYSTEM_PROMPT = `
You are ELIZA-AI, a hybrid conversational intelligence combining classic ELIZA-style reflective empathy with a modern persistent cognitive layer.

Core Guidelines:
1. Speak concisely, clearly, and naturally in a terminal conversation.
2. If persistent memories or knowledge are provided in your context, use them accurately to maintain continuity.
3. Never invent or hallucinate facts or memories that are not present in your persistent context.
4. When the user gives corrections or updates (e.g. "I switched from SQLite to PostgreSQL"), acknowledge the update directly.
5. Embody an attentive, analytical, and respectful conversational style.
`.trim();

export const MEMORY_EXTRACTION_PROMPT = `
Analyze the following conversation turn between User and Assistant.
Extract any durable facts, user preferences, current projects, goals, instructions, or explicit corrections.
Do NOT infer sensitive personal secrets or wild speculations.
Only extract clear, explicit statements made by the user.

Return ONLY valid JSON adhering strictly to this schema:
{
  "memories": [
    {
      "type": "fact" | "preference" | "goal" | "project" | "concept" | "relationship" | "instruction" | "correction" | "observation",
      "content": "A concise declarative sentence summarizing what was learned (e.g., 'The user is building a Bun CLI chatbot.')",
      "confidence": 0.0 to 1.0,
      "importance": 0.0 to 1.0,
      "tags": ["relevant", "keywords"]
    }
  ],
  "knowledge": [
    {
      "title": "Short title for a general concept or technology explained by user",
      "content": "Concise summary of the concept",
      "category": "programming" | "science" | "technology" | "projects" | "concept" | "definition",
      "confidence": 0.0 to 1.0
    }
  ],
  "corrections": [
    {
      "target": "What previous concept or belief was corrected or changed",
      "newValue": "The new corrected truth"
    }
  ]
}
If no relevant durable information was stated, return:
{"memories": [], "knowledge": [], "corrections": []}
`.trim();

export const EVALUATION_PROMPT = `
Evaluate the assistant's response to the user within the given context.
Check for relevance, factual consistency, whether available memories were utilized properly, and whether there is any risk of hallucination.

Return ONLY valid JSON matching this schema:
{
  "score": 0.0 to 1.0,
  "relevant": true | false,
  "used_memory": true | false,
  "potential_hallucination": true | false,
  "notes": "Short 1-2 sentence evaluation"
}
`.trim();

export const CANDIDATE_RULE_PROMPT = `
Review the recent conversation. Propose a new deterministic ELIZA pattern rule ONLY IF there is a distinct, recurring conversational pattern or intent that would benefit from a predictable rule.
Return ONLY valid JSON:
{
  "proposals": [
    {
      "keywords": ["keyword1", "keyword2"],
      "patterns": ["* keyword1 *", "i am keyword2 *"],
      "responses": [
        "Response template 1 with optional {0} reflection.",
        "Alternative response template 2."
      ],
      "priority": 8,
      "reason": "Why this rule is useful"
    }
  ]
}
If no new rule is needed, return {"proposals": []}.
`.trim();
