---
name: translate-cws-listing
description: Translate Chrome Web Store listing (title, short description, long description) to a target language with SEO optimization. Use when user wants to translate CWS descriptions, create localized store listings, or prepare multilingual Chrome Web Store content. Argument is a language code from docs/lang/Language.md (e.g., ru, ja, ar).
---

# Translate CWS Listing

Translate the English Chrome Web Store listing to a target language with SEO adaptation.

## Input

The argument is a language code (e.g., `ru`, `ja`, `ar`). Validate it exists in `docs/lang/Language.md`.

## Steps

1. **Read the English template:** `docs/lang/EN.md`
2. **Read the target language file** `docs/lang/{CODE}.md` — if it already exists, ask the user whether to overwrite
3. **Translate all three sections** with strict character limits:

### Title (max 45 characters)
- Translate the title naturally for the target language
- Include "Ho'oponopono" (or the locally recognized spelling variant)
- MUST be ≤ 45 characters. Count characters carefully. If over limit, shorten by removing less important words
- Verify the count explicitly before writing

### Short Description (max 132 characters)
- Translate preserving the core message: practice + global community + healing/peace
- Include high-volume SEO keywords for the target language (meditation, prayer, healing, forgiveness)
- IMPORTANT: The extension supports 50+ languages (not 12). Use "50+" / "более 50" / equivalent in translations
- Do NOT include the "100% Free Forever / open-source" feature bullet — it was removed from the listing
- MUST be ≤ 132 characters. Count and verify explicitly
- If over limit, trim filler words while keeping SEO terms

### Long Description (max 4500 characters)
- Translate the full description preserving:
  - All emoji at the start of paragraphs (🌺, 🌊, ✨, 💧, etc.)
  - Section headers with emoji (🌺 ... 🌺, 💻 ... 💻, etc.)
  - Markdown structure and formatting
  - The 🌟 feature list format
  - Numbered steps (1️⃣, 2️⃣, etc.)
- SEO adaptation for the target language:
  - Add local spelling variants of "ho'oponopono" (e.g., хоопонопоно for Russian, ホオポノポノ for Japanese)
  - Include popular search terms for meditation/healing/forgiveness/mantra in that language
  - Keep the English term "Ho'oponopono" alongside the local variant for searchability
- MUST be ≤ 4500 characters. Count and verify explicitly
- If over limit, trim verbose phrases while preserving all sections and SEO keywords

## SEO Guidelines

Research and include these types of local keywords naturally in the text:
- Local transliteration/spelling of "ho'oponopono"
- "Hawaiian meditation/prayer/ritual" in target language
- "forgiveness meditation" in target language
- "healing mantra" in target language
- "I'm sorry, Please forgive me, Thank you, I love you" translated
- Popular related search terms (mindfulness, inner peace, stress relief, etc.)

## Output

Save the translated listing to `docs/lang/{CODE}.md` using the exact same format as EN.md:

```
## Title (max 45 chars)
` ` `
{translated title}
` ` `
## Short Description (max 132 chars)

` ` `
{translated short description}
` ` `

## Long Description (max 4500 chars)

` ` `
{translated long description}
` ` `
```

## Verification

After writing the file, verify:
1. Title character count ≤ 45
2. Short description character count ≤ 132
3. Long description character count ≤ 4500
4. All three sections present with correct headers
5. Emoji structure preserved
6. Local SEO keywords present
7. Print a summary: language, char counts for each section, key SEO terms used

## After Translation

Update `docs/lang/Language.md` — mark the translated language with `[x]`.

## Special Cases

- **RTL languages** (ar, he, fa): Text direction doesn't affect the markdown file, but ensure the translation reads naturally in RTL
- **CJK languages** (ja, zh_CN, zh_TW, ko): Characters count as 1 each for CWS limits. CJK text is typically shorter in character count but conveys the same meaning
- **Languages with longer words** (de, fi, hu): May need more aggressive trimming to fit character limits. Prioritize SEO keywords when trimming
