---
name: telegram-formatting
description: Skill for formatting messages correctly for Telegram. Use when responding via Telegram to ensure messages render properly.
---

# Telegram Formatting Skill

You are responding via Telegram. Follow these rules to ensure messages render correctly.

## Supported Formatting (Markdown)

Telegram uses a subset of Markdown. Use ONLY these:

- `*bold*` → **bold**
- `_italic_` → _italic_
- `` `inline code` `` → `inline code`
- ` ```language\ncode block\n``` ` → code block with syntax highlighting
- `~strikethrough~` → ~~strikethrough~~
- `[text](url)` → clickable link

## Rules

1. **Keep messages concise.** Telegram is mobile-first. No walls of text.
2. **Use bullet points** (`-` or `•`) for lists. Numbered lists work too.
3. **Use bold for emphasis**, not ALL CAPS.
4. **Code blocks**: always specify the language after triple backticks for syntax highlighting.
5. **No HTML tags.** Telegram Markdown does not support `<br>`, `<p>`, etc.
6. **No headers.** Telegram does not render `#`, `##`, etc. Use **bold text** on its own line instead.
7. **Emojis are encouraged.** They improve readability on mobile: ✅ ❌ 📁 🔧 📋 🚀 ⚠️
8. **Max message length is 4096 chars.** If your response is longer, break it into logical sections.
9. **Tables don't render.** Use aligned text with code blocks or bullet points instead.
10. **Escape special characters** if they appear literally and are not formatting: `_`, `*`, `` ` ``, `[`, `~`.

## Message Structure

For informational responses:
```
📋 *Title or Topic*

Brief summary or context.

- Point one
- Point two
- Point three

✅ Conclusion or next step
```

For status/progress:
```
🚀 *Project Name*

Status: ✅ Active
Last update: 22 Apr 2026

- Task 1: ✅ Done
- Task 2: ⏳ In progress
- Task 3: ❌ Blocked
```

For code responses:
```
Here's the fix:

` ` `typescript
const result = await fetchData();
` ` `

Apply it in `src/utils.ts` line 42.
```

## Anti-patterns

- ❌ Long paragraphs → ✅ Short bullets
- ❌ `## Headers` → ✅ `*Bold title*`
- ❌ HTML tables → ✅ Bullet lists or code blocks
- ❌ Nested formatting `*_bold italic_*` → ✅ Keep it simple
- ❌ Unescaped special chars → ✅ Escape with `\`

## Reactions

You can react to user messages with `telegram_react`. Only these 83 emojis are valid:

👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡

Rules:
- Only 1 reaction per message (bot limitation)
- Do NOT use any emoji outside this list — the API will reject it
- React proactively: 👀 when reviewing, ✅ when done, 🔥 for excitement, 🤔 when analyzing
