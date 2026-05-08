/**
 * Telegram HTML utilities — Markdown→HTML conversion and UTF-8 safe splitting.
 *
 * Extracted from TelegramAdapter for reuse across adapters.
 */

const TELEGRAM_MAX_LENGTH = 4096;

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert agent Markdown to Telegram HTML.
 * Handles: **bold**, *italic*, `code`, ```blocks```, [links](url), ~~strike~~
 * Preserves code blocks untouched.
 */
export function mdToHtml(text: string): string {
  const codeBlocks: string[] = [];

  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  result = result.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CB${idx}\x00`;
  });

  result = escapeHtml(result);
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  return result;
}

/** Split text into chunks that fit within maxLen, respecting UTF-8 char boundaries. */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    while (splitAt > 0 && isContinuationByte(remaining, splitAt)) {
      splitAt--;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}

/** Check if char at position is a UTF-16 low surrogate (don't split surrogate pairs). */
function isContinuationByte(str: string, pos: number): boolean {
  const code = str.charCodeAt(pos);
  return code >= 0xDC00 && code <= 0xDFFF;
}
