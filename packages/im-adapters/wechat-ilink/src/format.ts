import { Lexer } from "marked";
import type { Token, Tokens } from "marked";

// Preserve WeChat's supported Markdown and literal code. Inline images fall
// back to usable links; native images travel through the media channel.
export function formatWechatText(text: string): string {
  return replaceTokens(text, Lexer.lex(text, { gfm: true }));
}

function replaceTokens(source: string, tokens: readonly Token[]): string {
  let result = "";
  let offset = 0;
  for (const token of tokens) {
    const index = source.indexOf(token.raw, offset);
    if (index < 0 || !token.raw) continue;
    result += source.slice(offset, index) + renderToken(token);
    offset = index + token.raw.length;
  }
  return result + source.slice(offset);
}

function renderToken(token: Token): string {
  if (token.type === "code" || token.type === "codespan" || token.type === "html") return token.raw;
  if (token.type === "image") {
    const image = token as Tokens.Image;
    const label = image.text.replace(/[[\]\\]/gu, "\\$&") || "图片";
    return /^https?:\/\//iu.test(image.href)
      ? `[${label}](<${image.href.replace(/>/gu, "%3E")}>)`
      : label;
  }
  if (
    token.type === "em" &&
    /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(String(token.text))
  ) {
    return replaceTokens(String(token.text), token.tokens ?? []);
  }
  let rendered = token.raw;
  if (token.type === "table") {
    const table = token as Tokens.Table;
    rendered = replaceTokens(
      rendered,
      [...table.header, ...table.rows.flat()].flatMap((cell) => cell.tokens),
    );
  } else if (token.type === "list") {
    rendered = replaceTokens(rendered, (token as Tokens.List).items);
  } else if ("tokens" in token && token.tokens) rendered = replaceTokens(rendered, token.tokens);
  if (token.type === "heading" && (token as Tokens.Heading).depth > 4) {
    rendered = rendered.replace(/^ {0,3}#{5,6}[ \t]+/u, "").replace(/[ \t]+#+[ \t]*(?=\n?$)/u, "");
  }
  return rendered;
}
