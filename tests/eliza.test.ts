import { describe, expect, test } from "bun:test";
import { reflectPronouns } from "../src/eliza/reflection.ts";
import { ElizaMatcher } from "../src/eliza/matcher.ts";
import { ElizaRuleRegistry } from "../src/eliza/patterns.ts";
import { BotDatabase } from "../src/db/database.ts";
import { defaultConfig } from "../src/config.ts";

describe("ELIZA Reflection", () => {
  test("reflects first person to second person", () => {
    expect(reflectPronouns("I am happy")).toBe("you are happy");
    expect(reflectPronouns("my mother")).toBe("your mother");
    expect(reflectPronouns("this is mine")).toBe("this is yours");
    expect(reflectPronouns("I think about myself")).toBe("you think about yourself");
  });

  test("reflects second person to first person", () => {
    expect(reflectPronouns("you are kind")).toBe("I am kind");
    expect(reflectPronouns("your idea")).toBe("my idea");
    expect(reflectPronouns("is it yours")).toBe("is it mine");
  });

  test("handles contractions correctly", () => {
    expect(reflectPronouns("I'm feeling fine")).toBe("you are feeling fine");
    expect(reflectPronouns("I've noticed something")).toBe("you have noticed something");
    expect(reflectPronouns("I'll do it")).toBe("you will do it");
  });

  test("does not recursively double-reflect", () => {
    // "you and I" -> "I and you" (not "I and I" or "you and you")
    expect(reflectPronouns("you and I")).toBe("I and you");
  });

  test("cleans trailing punctuation", () => {
    expect(reflectPronouns("my code???")).toBe("your code");
  });
});

describe("ELIZA Pattern Matcher", () => {
  const sampleRules = [
    {
      id: "rule_mother",
      keywords: ["mother", "mom"],
      patterns: ["* mother *", "mother"],
      responses: ["Tell me more about your mother."],
      priority: 10,
    },
    {
      id: "rule_feel",
      keywords: ["feel"],
      patterns: ["i feel *", "* feel *"],
      responses: ["Why do you feel {0}?"],
      priority: 12,
    },
    {
      id: "rule_i_am",
      keywords: ["i am", "i'm"],
      patterns: ["i am *", "i'm *"],
      responses: ["How long have you been {0}?"],
      priority: 8,
    },
    {
      id: "rule_generic",
      keywords: [],
      patterns: ["*"],
      responses: ["Tell me more."],
      priority: 1,
    },
  ];

  const matcher = new ElizaMatcher(sampleRules);

  test("matches exact keywords and highest priority rule", () => {
    const match = matcher.match("I feel very excited about this");
    expect(match).not.toBeNull();
    expect(match?.ruleId).toBe("rule_feel");
    expect(match?.response).toBe("Why do you feel very excited about this?");
  });

  test("reflects pronouns in wildcard captures", () => {
    const match = matcher.match("I am worried about my project");
    expect(match).not.toBeNull();
    expect(match?.ruleId).toBe("rule_i_am");
    expect(match?.response).toBe("How long have you been worried about your project?");
  });

  test("falls back to generic rule when no specific keyword matches", () => {
    const match = matcher.match("Random statement without keywords");
    expect(match).not.toBeNull();
    expect(match?.ruleId).toBe("rule_generic");
    expect(match?.response).toBe("Tell me more.");
  });

  test("supports dynamic candidate and approved rules from registry", () => {
    const memDb = new BotDatabase(":memory:");
    const registry = new ElizaRuleRegistry(defaultConfig.rulesPath, memDb);

    const ruleId = registry.addCandidateRule({
      keywords: ["quantum"],
      patterns: ["* quantum *"],
      responses: ["What do you understand about quantum mechanics?"],
      priority: 15,
    });

    expect(registry.getRules().some((r) => r.id === ruleId)).toBe(false); // Candidate not in active rules

    registry.setRuleStatus(ruleId, "approved");
    expect(registry.getRules().some((r) => r.id === ruleId)).toBe(true); // Now approved

    matcher.updateRules(registry.getRules());
    const match = matcher.match("I am studying quantum computing");
    expect(match?.ruleId).toBe(ruleId);
    expect(match?.response).toBe("What do you understand about quantum mechanics?");

    memDb.close();
  });
});
