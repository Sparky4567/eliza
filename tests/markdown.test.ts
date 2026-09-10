import { describe, expect, test } from "bun:test";
import { expandEmojiShortcodes, renderMarkdown } from "../public/markdown.ts";

describe("Markdown renderer (web UI)", () => {
  test("headings, bold, italic, strikethrough, inline code", () => {
    const html = renderMarkdown("# Hi\n\nHello **bold** and *italic* and ~~gone~~ with `code`.");
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<code>code</code>");
  });

  test("fenced code blocks keep source escaped + carry language + copy button", () => {
    const html = renderMarkdown("```js\nconst a = \"<b>\";\n```");
    expect(html).toContain("language-js");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("data-code-copy");
    expect(html).not.toContain("<b>");
  });

  test("lists incl. task items and nesting", () => {
    const html = renderMarkdown("- [ ] todo\n- [x] done\n- a\n  - nested\n1. first\n2. second");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("nested");
  });

  test("links, images, tables, blockquote, hr", () => {
    const html = renderMarkdown(
      "> quoted\n\n---\n\n[text](https://example.com)\n\n![alt](https://example.com/i.png)\n\n| a | b |\n| --- | ---: |\n| 1 | 2 |"
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<img");
    expect(html).toContain("<table>");
  });

  test("XSS: raw HTML escaped, javascript: URLs neutralized", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:");
    // unsafe link degrades to its text (no anchor emitted)
    expect(html).not.toContain("<a ");
  });

  test("unclosed fence degrades to a code block instead of dumping raw", () => {
    const html = renderMarkdown("```python\nprint('hi')");
    expect(html).toContain("<pre>");
    expect(html).toContain("print");
  });

  test("emoji shortcodes expand in prose, unknown codes stay literal", () => {
    expect(expandEmojiShortcodes(":rocket: lift off :tada:")).toBe("🚀 lift off 🎉");
    expect(expandEmojiShortcodes(":definitely_not_real:")).toBe(":definitely_not_real:");
    expect(expandEmojiShortcodes("meet at 10:30")).toBe("meet at 10:30");
    const html = renderMarkdown("Deploy :rocket: with **care** :+1:");
    expect(html).toContain("🚀");
    expect(html).toContain("👍");
  });

  test("shortcodes inside code spans and fences stay literal", () => {
    const inline = renderMarkdown("Use `:rocket:` not :tada: here");
    expect(inline).toContain("<code>:rocket:</code>");
    expect(inline).toContain("🎉");
    const fenced = renderMarkdown("```\n:rocket:\n```");
    expect(fenced).toContain(":rocket:");
    expect(fenced).not.toContain("🚀");
  });
});
