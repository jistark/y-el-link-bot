# El Mercurio + LUN article reconstruction — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct El Mercurio papel-digital articles closer to the printed page (kicker, byline, quotes, photo with caption) and detect "story groups" (anchor + recuadros) for single-shot rendering. Add equivalent enrichment to LUN.

**Architecture:** Whitelist-based sanitizer for El Mercurio markup; `parseArticleName` + `groupPageArticles` for detecting recuadros via `_R\d+\.ART$` naming; new `extractStoryGroup` that fetches anchor + recuadros in parallel and composes one Telegraph page; `pendingPages` callback supports both `empage:g:N` (group) and `empage:a:N` (article); LUN extractor gets `<div id="autor">`, page cover URL, video.

**Tech Stack:** TypeScript, Bun runtime, grammy.js, Telegraph API. Tests via `bun:test` (built-in).

**Spec:** [`2026-04-26-elmercurio-lun-reconstruction-design.md`](../specs/2026-04-26-elmercurio-lun-reconstruction-design.md)

---

## File structure

| File | Responsibility |
|------|---------------|
| `src/extractors/elmercurio.ts` | All Mercurio extraction. Add: sanitizer, parseArticleName, groupPageArticles, extractStoryGroup. Modify: extractFromDigitalJson, fetchPageArticles. |
| `src/extractors/lun.ts` | All LUN extraction. Add: buildLunPageCoverUrl. Modify: extractLunContent (autor, video). |
| `src/types.ts` | Add `kicker?: string` and `coverImage?: { url: string; caption?: string }` to `Article`. |
| `src/formatters/telegraph.ts` | Render `kicker` as first `<p><b>` node and prepend `coverImage` figure when present. |
| `src/bot.ts` | New callback parsing for `empage:g:N` / `empage:a:N`; auto-extract single-group case; sanitize titles in selector. |
| `test/elmercurio.test.ts` | Unit tests for sanitizer, parseArticleName, groupPageArticles. |
| `test/lun.test.ts` | Unit tests for buildLunPageCoverUrl. |
| `test/fixtures/elmercurio_b12_2026-04-25.json` | Real page JSON fixture (story group of 5). |
| `test/fixtures/elmercurio_b1_2026-04-25.json` | Real page JSON fixture (no group, banners + NO_WEB). |
| `test/fixtures/elmercurio_buchi_anchor.json` | Real article JSON fixture (anchor with kicker, quotes, images). |

---

## Phase 0: Test infrastructure

### Task 0.1: Wire `bun test` into the project

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Add `test` script and `bun:test` types to `package.json`.

```json
{
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test"
  }
}
```

- [ ] **Step 2:** Verify command runs (no tests yet → exits 0 with "0 tests").

```bash
cd /Users/ji/Sites/jdv-bot && bun test
```

Expected: `0 pass, 0 fail` (or "no tests found").

- [ ] **Step 3:** Commit.

```bash
git add package.json
git commit -m "Wire bun test runner"
```

### Task 0.2: Capture fixtures from real production data

**Files:**
- Create: `test/fixtures/elmercurio_b12_2026-04-25.json` (page JSON, story group of 5)
- Create: `test/fixtures/elmercurio_b1_2026-04-25.json` (page JSON, no groups)
- Create: `test/fixtures/elmercurio_buchi_anchor.json` (article JSON for anchor)
- Create: `test/fixtures/elmercurio_buchi_recuadro.json` (article JSON for recuadro 1)
- Create: `test/fixtures/lun_p13_2026-04-26.html` (LUN Homemob HTML)

- [ ] **Step 1:** Fetch and save fixtures.

```bash
mkdir -p /Users/ji/Sites/jdv-bot/test/fixtures
cd /Users/ji/Sites/jdv-bot/test/fixtures
curl -sL "https://digital.elmercurio.com/2026/04/25/content/pages/3A4KSPJP.json" -o elmercurio_b12_2026-04-25.json
curl -sL "https://digital.elmercurio.com/2026/04/25/content/pages/3A4KSPGH.json" -o elmercurio_b1_2026-04-25.json
curl -sL "https://digital.elmercurio.com/2026/04/25/content/articles/4H4L0L3D.json" -o elmercurio_buchi_anchor.json
curl -sL "https://digital.elmercurio.com/2026/04/25/content/articles/C14L0L7D.json" -o elmercurio_buchi_recuadro.json
curl -sL "https://www.lun.com/lunmobileiphone/Homemob.aspx?dt=2026-04-26&bodyid=0&SupplementId=0&PaginaId=13&NewsId=561548" -o lun_p13_2026-04-26.html
ls -la
```

Expected: 5 files, each > 1KB.

- [ ] **Step 2:** Verify fixtures parse correctly.

```bash
cd /Users/ji/Sites/jdv-bot
python3 -c "import json; d=json.load(open('test/fixtures/elmercurio_b12_2026-04-25.json')); assert len(d['articles'])==5, d; print('B12 ok:', len(d['articles']))"
python3 -c "import json; d=json.load(open('test/fixtures/elmercurio_b1_2026-04-25.json')); assert len(d['articles'])>=8, d; print('B1 ok:', len(d['articles']))"
python3 -c "import json; d=json.load(open('test/fixtures/elmercurio_buchi_anchor.json')); assert d.get('head_label'), d; print('anchor ok')"
```

Expected: all three asserts print "ok".

- [ ] **Step 3:** Commit.

```bash
git add test/fixtures/
git commit -m "Add fixtures for Mercurio + LUN extractor tests"
```

---

## Phase 1: Sanitizer + kicker + quotes + sanitize selector titles

### Task 1.1: Add `kicker` field to `Article` type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1:** Add `kicker?: string` field after `title`.

```typescript
export interface Article {
  title: string;
  kicker?: string;          // antetítulo / volada (e.g. "ANTONIO BÜCHI, CEO DE ENTEL:")
  subtitle?: string;
  author?: string;
  date?: string;
  body: string;
  images?: { url: string; caption?: string }[];
  url: string;
  source: 'elmercurio' | 'lasegunda' | 'latercera' | 'df' | 'theverge' | 'lun' | 'nyt' | 'wapo' | 'cnnchile' | 'biobio' | 'elpais' | 'ft' | 'theatlantic' | 'wired' | '404media' | 'bloomberg' | 'adnradio' | 'elfiltrador' | 'theclinic' | 'exante' | 'interferencia' | 't13' | '13cl' | 'tvn' | '24horas' | 'mega' | 'meganoticias' | 'chilevision' | 'ojoalatele' | 'adprensa' | 'lahora' | 'emol' | 'generic';
}
```

- [ ] **Step 2:** Verify TypeScript still compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `kicker`.

- [ ] **Step 3:** Commit.

```bash
git add src/types.ts
git commit -m "Add kicker field to Article type"
```

### Task 1.2: Render `kicker` in Telegraph formatter

**Files:**
- Modify: `src/formatters/telegraph.ts`

- [ ] **Step 1:** Modify `articleToNodes` to prepend kicker before subtitle.

Find the function `articleToNodes` (around line 312) and add the kicker block at the very start of `nodes`:

```typescript
export function articleToNodes(article: Article): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];

  // Kicker (antetítulo) como primer párrafo en negrita
  if (article.kicker) {
    nodes.push({ tag: 'p', children: [{ tag: 'b', children: [decodeEntities(article.kicker)] }] });
  }

  // Subtítulo como blockquote
  if (article.subtitle) {
    nodes.push({ tag: 'blockquote', children: [decodeEntities(article.subtitle)] });
  }

  // ... resto sin cambios
```

- [ ] **Step 2:** Verify compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 3:** Commit.

```bash
git add src/formatters/telegraph.ts
git commit -m "Render kicker as first node in Telegraph"
```

### Task 1.3: Write failing tests for `sanitizeMercurioMarkup`

**Files:**
- Create: `test/elmercurio.test.ts`

- [ ] **Step 1:** Write test file.

```typescript
import { describe, expect, it } from 'bun:test';
import { sanitizeMercurioMarkup } from '../src/extractors/elmercurio.js';

describe('sanitizeMercurioMarkup', () => {
  it('converts <P> to <p>', () => {
    expect(sanitizeMercurioMarkup('<P>Hola</P>')).toBe('<p>Hola</p>');
  });

  it('converts <subhead> to <h3>', () => {
    expect(sanitizeMercurioMarkup('<subhead>Tema</subhead>')).toBe('<h3>Tema</h3>');
  });

  it('converts <bold> to <b> and <italic> to <i>', () => {
    expect(sanitizeMercurioMarkup('<bold>x</bold> <italic>y</italic>')).toBe('<b>x</b> <i>y</i>');
  });

  it('converts <bold_intro> to <p><b>', () => {
    expect(sanitizeMercurioMarkup('<bold_intro>—¿Pregunta?</bold_intro>'))
      .toBe('<p><b>—¿Pregunta?</b></p>');
  });

  it('converts <leadin> to <b>', () => {
    expect(sanitizeMercurioMarkup('<leadin>Inicio</leadin> resto'))
      .toBe('<b>Inicio</b> resto');
  });

  it('removes <dropcap/>', () => {
    expect(sanitizeMercurioMarkup('<dropcap/>Antonio')).toBe('Antonio');
  });

  it('removes <highlight> tags but keeps content', () => {
    expect(sanitizeMercurioMarkup('<highlight>Confío más</highlight> en')).toBe('Confío más en');
  });

  it('removes unknown tags but preserves content', () => {
    expect(sanitizeMercurioMarkup('<foo>texto</foo>')).toBe('texto');
  });

  it('handles nested known tags', () => {
    expect(sanitizeMercurioMarkup('<bold>Hola <italic>mundo</italic></bold>'))
      .toBe('<b>Hola <i>mundo</i></b>');
  });

  it('handles empty input', () => {
    expect(sanitizeMercurioMarkup('')).toBe('');
  });

  it('strips outer <body> wrapper', () => {
    expect(sanitizeMercurioMarkup('<body><P>x</P></body>')).toBe('<p>x</p>');
  });
});
```

- [ ] **Step 2:** Run tests, verify they fail (function doesn't exist).

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | head -20
```

Expected: failure — `sanitizeMercurioMarkup` is not exported.

- [ ] **Step 3:** Commit failing tests.

```bash
git add test/elmercurio.test.ts
git commit -m "Add failing tests for sanitizeMercurioMarkup"
```

### Task 1.4: Implement `sanitizeMercurioMarkup`

**Files:**
- Modify: `src/extractors/elmercurio.ts`

- [ ] **Step 1:** Add the sanitizer at the top of the file (after imports, before `parseUrl`).

```typescript
// Whitelist-based sanitizer for El Mercurio markup tags.
// Converts known proprietary tags to standard HTML; strips unknown tags
// but preserves their text content.
export function sanitizeMercurioMarkup(input: string): string {
  if (!input) return '';
  let s = input;

  // Self-closing first
  s = s.replace(/<dropcap\s*\/?>/gi, '');

  // Wrappers we want to drop entirely (outer container only — content kept)
  s = s.replace(/<\/?body>/gi, '');
  s = s.replace(/<\/?head_label>/gi, '');
  s = s.replace(/<\/?head_deck>/gi, '');
  s = s.replace(/<\/?byline>/gi, '');
  s = s.replace(/<\/?byline_credit>/gi, '');
  s = s.replace(/<\/?head>/gi, '');
  s = s.replace(/<\/?quote>/gi, '');

  // Tag substitutions
  s = s.replace(/<bold_intro>([\s\S]*?)<\/bold_intro>/gi, '<p><b>$1</b></p>');
  s = s.replace(/<leadin>([\s\S]*?)<\/leadin>/gi, '<b>$1</b>');
  s = s.replace(/<subhead>([\s\S]*?)<\/subhead>/gi, '<h3>$1</h3>');
  s = s.replace(/<bold>/gi, '<b>').replace(/<\/bold>/gi, '</b>');
  s = s.replace(/<italic>/gi, '<i>').replace(/<\/italic>/gi, '</i>');
  s = s.replace(/<P(\s[^>]*)?>/gi, '<p>').replace(/<\/P>/gi, '</p>');

  // Strip <highlight> wrapper but keep content
  s = s.replace(/<\/?highlight>/gi, '');

  // Strip any remaining unknown tags (preserve content)
  // Allowed: p, b, i, h3, h4, blockquote, figure, img, figcaption, br, a, hr, aside
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]*)(\s[^>]*)?>/g, (m, tag) => {
    const allowed = new Set(['p', 'b', 'i', 'h3', 'h4', 'blockquote', 'figure', 'img', 'figcaption', 'br', 'a', 'hr', 'aside', 'em', 'strong']);
    return allowed.has(tag.toLowerCase()) ? m : '';
  });

  return s.trim();
}
```

- [ ] **Step 2:** Run tests, verify they pass.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | tail -20
```

Expected: 11 pass, 0 fail.

- [ ] **Step 3:** Commit.

```bash
git add src/extractors/elmercurio.ts
git commit -m "Implement sanitizeMercurioMarkup whitelist sanitizer"
```

### Task 1.5: Use sanitizer in `extractFromDigitalJson` + extract `kicker` and `quotes`

**Files:**
- Modify: `src/extractors/elmercurio.ts`

- [ ] **Step 1:** Add types for the article JSON additional fields.

Update the `MercurioJsonArticle` interface (around line 4) to include the new fields:

```typescript
interface MercurioJsonArticle {
  title?: string;
  head?: string;
  head_label?: string;
  head_deck?: string;
  byline?: string;
  body?: string;
  quotes?: { quote: string }[];
  images?: {
    path: string;
    caption?: string;
    credits?: string;
    name?: string;
    noExport?: boolean;
    infographic?: boolean;
  }[];
}
```

- [ ] **Step 2:** Replace the body of `extractFromDigitalJson` (around line 167-205) to use the sanitizer and extract kicker + quotes.

```typescript
async function extractFromDigitalJson(date: string, articleId: string): Promise<Article> {
  const jsonUrl = `https://digital.elmercurio.com/${date}/content/articles/${articleId}.json`;

  const response = await fetch(jsonUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const data: MercurioJsonArticle = await response.json();

  // Title: prefer `title`, fall back to `head`. Sanitize either way.
  const rawTitle = data.title || data.head;
  if (!rawTitle) {
    throw new Error('Artículo sin título');
  }
  const title = stripTags(sanitizeMercurioMarkup(rawTitle));

  // Kicker (volada/antetítulo)
  const kicker = data.head_label
    ? stripTags(sanitizeMercurioMarkup(data.head_label))
    : undefined;

  // Subtitle (bajada)
  const subtitle = data.head_deck
    ? stripTags(sanitizeMercurioMarkup(data.head_deck))
    : undefined;

  // Author
  const author = data.byline
    ? stripTags(sanitizeMercurioMarkup(data.byline)).replace(/^Por\s+/i, '').trim()
    : undefined;

  // Quotes block (rendered as blockquotes prepended to body)
  const quoteBlocks = (data.quotes || [])
    .map(q => sanitizeMercurioMarkup(q.quote || ''))
    .filter(Boolean)
    .map(q => `<blockquote>${q}</blockquote>`)
    .join('\n');

  // Body sanitized
  const sanitizedBody = sanitizeMercurioMarkup(data.body || '');
  const body = quoteBlocks
    ? `${quoteBlocks}\n${sanitizedBody}`
    : sanitizedBody;

  // Images: filter by noExport=false AND infographic=false
  // (DO NOT filter by name starting with NO_WEB_; main article photos use that prefix)
  const images = (data.images || [])
    .filter(img => img.noExport === false && img.infographic === false && img.path)
    .map(img => {
      const url = `https://digital.elmercurio.com/${date}/content/pages/img/mid/${img.path}`;
      let caption = img.caption ? stripTags(sanitizeMercurioMarkup(img.caption)) : undefined;
      if (img.credits) {
        caption = caption ? `${caption} (Foto: ${img.credits})` : `Foto: ${img.credits}`;
      }
      return { url, caption };
    });

  return {
    title,
    kicker,
    subtitle,
    author,
    body,
    images: images.length > 0 ? images : undefined,
    url: `https://digital.elmercurio.com/${date}/content/articles/${articleId}`,
    source: 'elmercurio',
  };
}

// Strips all HTML tags, preserving text content. Used after sanitizeMercurioMarkup
// for fields rendered as plain text (title, kicker, subtitle, author).
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 3:** Verify TypeScript compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4:** Add a test that uses the fixture to verify extraction.

Add to `test/elmercurio.test.ts`:

```typescript
import buchiAnchor from './fixtures/elmercurio_buchi_anchor.json';

describe('extractFromDigitalJson (via fixture parsing)', () => {
  it('extracts kicker, quotes, and image from Büchi article JSON', () => {
    // We can't call extractFromDigitalJson directly (it does network fetch),
    // but we can verify the fixture has the expected structure.
    expect(buchiAnchor.head_label).toContain('Büchi');
    expect(buchiAnchor.quotes).toHaveLength(2);
    expect(buchiAnchor.images.length).toBeGreaterThanOrEqual(1);
    const mainPhoto = buchiAnchor.images.find(i => i.caption?.includes('CEO de Entel'));
    expect(mainPhoto).toBeDefined();
    expect(mainPhoto!.noExport).toBe(false);
    expect(mainPhoto!.name).toMatch(/NO_WEB_/);  // prefix on the name despite noExport=false
  });
});
```

- [ ] **Step 5:** Run tests, verify pass.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 6:** Commit.

```bash
git add src/extractors/elmercurio.ts test/elmercurio.test.ts
git commit -m "Extract kicker, quotes, photo with caption in El Mercurio JSON path"
```

### Task 1.6: Sanitize titles in the page selector (bot.ts)

**Files:**
- Modify: `src/bot.ts`

- [ ] **Step 1:** Import `sanitizeMercurioMarkup` and a small helper `stripMercurioTags`.

In `src/bot.ts` find the import line:

```typescript
import { isPageUrl, fetchPageArticles, extractByArticleId, type PageArticleInfo } from './extractors/elmercurio.js';
```

Replace with:

```typescript
import { isPageUrl, fetchPageArticles, extractByArticleId, sanitizeMercurioMarkup, type PageArticleInfo } from './extractors/elmercurio.js';
```

- [ ] **Step 2:** In the selector building loop (around line 1242-1247), replace the line:

```typescript
text += `${NUMBER_EMOJIS[i]} ${escapeHtml(a.title)}\n`;
```

with:

```typescript
const cleanTitle = sanitizeMercurioMarkup(a.title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
text += `${NUMBER_EMOJIS[i]} ${escapeHtml(cleanTitle)}\n`;
```

- [ ] **Step 3:** Verify compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/bot.ts
git commit -m "Sanitize Mercurio markup in page selector titles"
```

---

## Phase 2: Mercurio images with `mid/` + caption + credits

Already covered as part of Phase 1 Task 1.5 (image extraction with `mid/` URL, caption + credits). Skip — keep numbering intact for spec traceability.

---

## Phase 3: LUN — autor + cover + bajada/volada

### Task 3.1: Add `coverImage` to Article type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1:** Add `coverImage` field. (We use a separate field rather than `image_url` because Telegraph derives the social image from the first `<img>` in content; we'll prepend a figure node when this is set.)

```typescript
export interface Article {
  title: string;
  kicker?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  body: string;
  images?: { url: string; caption?: string }[];
  coverImage?: { url: string; caption?: string };  // social/preview image
  url: string;
  source: ...
}
```

- [ ] **Step 2:** Verify compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 3:** Commit.

```bash
git add src/types.ts
git commit -m "Add coverImage field to Article"
```

### Task 3.2: Render `coverImage` first in Telegraph (so OG image picks it up)

**Files:**
- Modify: `src/formatters/telegraph.ts`

- [ ] **Step 1:** In `articleToNodes`, prepend cover image figure as the first node (before kicker).

Find the start of `articleToNodes` and insert before the kicker block:

```typescript
export function articleToNodes(article: Article): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];

  // Cover image (must be first <img> in content for Telegraph to use it as OG)
  if (article.coverImage?.url) {
    const coverChildren: TelegraphNode[] = [
      { tag: 'img', attrs: { src: article.coverImage.url } },
    ];
    if (article.coverImage.caption) {
      coverChildren.push({ tag: 'figcaption', children: [decodeEntities(article.coverImage.caption)] });
    }
    nodes.push({ tag: 'figure', children: coverChildren });
  }

  // Kicker (antetítulo) como primer párrafo en negrita
  if (article.kicker) {
    nodes.push({ tag: 'p', children: [{ tag: 'b', children: [decodeEntities(article.kicker)] }] });
  }

  // Subtítulo como blockquote
  if (article.subtitle) {
  // ... rest unchanged
```

- [ ] **Step 2:** Verify compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 3:** Commit.

```bash
git add src/formatters/telegraph.ts
git commit -m "Prepend coverImage figure as first Telegraph node"
```

### Task 3.3: Write failing tests for `buildLunPageCoverUrl`

**Files:**
- Create: `test/lun.test.ts`

- [ ] **Step 1:** Write failing test.

```typescript
import { describe, expect, it } from 'bun:test';
import { buildLunPageCoverUrl } from '../src/extractors/lun.js';

describe('buildLunPageCoverUrl', () => {
  it('builds URL with abbreviated month for April 2026', () => {
    expect(buildLunPageCoverUrl('2026-04-26', '13')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/abr/26/p_2026-04-26_pag13.webp'
    );
  });

  it('uses correct abbreviation for January', () => {
    expect(buildLunPageCoverUrl('2026-01-15', '7')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/ene/15/p_2026-01-15_pag7.webp'
    );
  });

  it('uses correct abbreviation for September', () => {
    expect(buildLunPageCoverUrl('2026-09-03', '1')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/sep/03/p_2026-09-03_pag1.webp'
    );
  });

  it('returns null for invalid date', () => {
    expect(buildLunPageCoverUrl('not-a-date', '1')).toBeNull();
    expect(buildLunPageCoverUrl('', '1')).toBeNull();
    expect(buildLunPageCoverUrl('2026-04-26', '')).toBeNull();
  });

  it('handles single-digit days (no padding required for output)', () => {
    expect(buildLunPageCoverUrl('2026-04-05', '1')).toBe(
      'https://images.lun.com/luncontents/NewsPaperPages/2026/abr/05/p_2026-04-05_pag1.webp'
    );
  });
});
```

- [ ] **Step 2:** Run tests, verify they fail.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/lun.test.ts 2>&1 | head -10
```

Expected: failure — `buildLunPageCoverUrl` not exported.

- [ ] **Step 3:** Commit failing tests.

```bash
git add test/lun.test.ts
git commit -m "Add failing tests for buildLunPageCoverUrl"
```

### Task 3.4: Implement `buildLunPageCoverUrl`

**Files:**
- Modify: `src/extractors/lun.ts`

- [ ] **Step 1:** Add function near the top of the file (after `parseLunUrl`):

```typescript
const SPANISH_MONTH_ABBR = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

export function buildLunPageCoverUrl(fechaIso: string, paginaId: string): string | null {
  if (!fechaIso || !paginaId) return null;
  const m = fechaIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, year, month, day] = m;
  const monthIdx = parseInt(month, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  const abbr = SPANISH_MONTH_ABBR[monthIdx];
  return `https://images.lun.com/luncontents/NewsPaperPages/${year}/${abbr}/${day}/p_${fechaIso}_pag${paginaId}.webp`;
}
```

- [ ] **Step 2:** Run tests, verify pass.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/lun.test.ts 2>&1 | tail -10
```

Expected: 5 pass, 0 fail.

- [ ] **Step 3:** Commit.

```bash
git add src/extractors/lun.ts
git commit -m "Add buildLunPageCoverUrl helper"
```

### Task 3.5: Capture LUN author from `<div id="autor">`

**Files:**
- Modify: `src/extractors/lun.ts`

- [ ] **Step 1:** Add `autor` to the `ExtractedContent` interface (around line 54):

```typescript
interface ExtractedContent {
  titulo: string | null;
  subtitulo: string | null;
  bajada: string | null;
  texto: string | null;
  seccion: string | null;
  autor: string | null;
  imagenes: string[];
  newsId: string | null;
  fecha: string | null;
}
```

- [ ] **Step 2:** Initialize `autor: null` in the `result` object (around line 66):

```typescript
const result: ExtractedContent = {
  titulo: null,
  subtitulo: null,
  bajada: null,
  texto: null,
  seccion: null,
  autor: null,
  imagenes: [],
  newsId: null,
  fecha: null,
};
```

- [ ] **Step 3:** Add extraction. After the `seccion` extraction block (around line 86):

```typescript
// Autor from div id="autor"
m = html.match(/<div id="autor">([^<]+)<\/div>/);
if (m) result.autor = decodeHtmlEntities(m[1].trim());
```

- [ ] **Step 4:** Use it in the returned `Article` (around line 207):

```typescript
return {
  title: content.titulo,
  subtitle: content.bajada || undefined,
  author: content.autor || undefined,
  date: content.fecha || params.fecha || undefined,
  body,
  images: images.length > 0 ? images : undefined,
  coverImage: pageCover,
  url,
  source: 'lun',
};
```

(We'll add `pageCover` in step 5.)

- [ ] **Step 5:** Compute `pageCover` before the return. Right before `return { title:...`:

```typescript
// Page cover (visual social card)
const coverUrl = buildLunPageCoverUrl(params.fecha, params.paginaId);
const pageCover = coverUrl ? { url: coverUrl } : undefined;
```

- [ ] **Step 6:** Verify TypeScript compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 7:** Commit.

```bash
git add src/extractors/lun.ts
git commit -m "Extract LUN author + page cover image"
```

---

## Phase 4: Story group detection + selector + auto-merge

### Task 4.1: Write failing tests for `parseArticleName`

**Files:**
- Modify: `test/elmercurio.test.ts`

- [ ] **Step 1:** Append tests for `parseArticleName`.

```typescript
import { parseArticleName } from '../src/extractors/elmercurio.js';

describe('parseArticleName', () => {
  it('parses anchor with T1 prefix', () => {
    expect(parseArticleName('T1_EyN_B12_2504_Büchi.ART')).toEqual({
      topicKey: 'T1',
      isRecuadro: false,
      recuadroIndex: null,
      normalizedKey: 'T1_EyN_B12_2504_Büchi',
      isValid: true,
    });
  });

  it('parses recuadro with T1 prefix and _R1 suffix', () => {
    expect(parseArticleName('T1_2_EyN_B12_2504_Büchi_R1.ART')).toEqual({
      topicKey: 'T1',
      isRecuadro: true,
      recuadroIndex: 1,
      normalizedKey: 'T1_EyN_B12_2504_Büchi',
      isValid: true,
    });
  });

  it('parses recuadro R3 with T1 prefix', () => {
    const r = parseArticleName('T1_4_EyN_B12_2504_Büchi_R3.ART');
    expect(r.isRecuadro).toBe(true);
    expect(r.recuadroIndex).toBe(3);
    expect(r.normalizedKey).toBe('T1_EyN_B12_2504_Büchi');
  });

  it('parses article without T-prefix', () => {
    const r = parseArticleName('EYN_B1_LLAMADO_A_2504.ART');
    expect(r.topicKey).toBeNull();
    expect(r.isRecuadro).toBe(false);
    expect(r.isValid).toBe(true);
  });

  it('rejects banner section files (.AR1)', () => {
    expect(parseArticleName('Chile.Nacional.Economía_y_Ne.AR1').isValid).toBe(false);
  });

  it('handles names with accented characters (ü)', () => {
    const r = parseArticleName('T1_2_X_Büchi_R1.ART');
    expect(r.normalizedKey).toBe('T1_X_Büchi');
  });

  it('handles names with periods in the middle', () => {
    expect(parseArticleName('Chile.Foo.Bar.AR1').isValid).toBe(false);
  });
});
```

- [ ] **Step 2:** Run tests, verify fail.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | tail -15
```

Expected: 7 new tests fail (`parseArticleName` not exported).

- [ ] **Step 3:** Commit.

```bash
git add test/elmercurio.test.ts
git commit -m "Add failing tests for parseArticleName"
```

### Task 4.2: Implement `parseArticleName`

**Files:**
- Modify: `src/extractors/elmercurio.ts`

- [ ] **Step 1:** Add the function and the type. Place after `sanitizeMercurioMarkup`:

```typescript
export interface ParsedArticleName {
  topicKey: string | null;       // e.g. "T1" if name starts with T<digits>_
  isRecuadro: boolean;            // ends in _R<digits>.ART
  recuadroIndex: number | null;   // the N from _R<N>
  normalizedKey: string;          // name minus _R<N>.ART and minus second _<digit>_ after T<N>_
  isValid: boolean;               // true if name ends in .ART (not .AR1 banner etc)
}

export function parseArticleName(name: string): ParsedArticleName {
  if (!name || !name.endsWith('.ART')) {
    return { topicKey: null, isRecuadro: false, recuadroIndex: null, normalizedKey: name, isValid: false };
  }
  let stem = name.slice(0, -4); // strip .ART

  // Detect _R<digit> suffix
  const recuadroMatch = stem.match(/_R(\d+)$/);
  let isRecuadro = false;
  let recuadroIndex: number | null = null;
  if (recuadroMatch) {
    isRecuadro = true;
    recuadroIndex = parseInt(recuadroMatch[1], 10);
    stem = stem.slice(0, -recuadroMatch[0].length);
  }

  // Detect T<digit> topic prefix
  const topicMatch = stem.match(/^(T\d+)_/);
  const topicKey = topicMatch ? topicMatch[1] : null;

  // Normalize: if T<digit>_<digit>_ pattern (recuadro positional), strip the second _<digit>_
  let normalizedKey = stem;
  if (topicKey) {
    const positional = normalizedKey.match(/^(T\d+)_(\d+)_(.+)$/);
    if (positional) {
      normalizedKey = `${positional[1]}_${positional[3]}`;
    }
  }

  return { topicKey, isRecuadro, recuadroIndex, normalizedKey, isValid: true };
}
```

- [ ] **Step 2:** Run tests, verify pass.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 3:** Commit.

```bash
git add src/extractors/elmercurio.ts
git commit -m "Implement parseArticleName"
```

### Task 4.3: Write failing tests for `groupPageArticles`

**Files:**
- Modify: `test/elmercurio.test.ts`

- [ ] **Step 1:** Append tests using fixtures.

```typescript
import { groupPageArticles } from '../src/extractors/elmercurio.js';
import b12Fixture from './fixtures/elmercurio_b12_2026-04-25.json';
import b1Fixture from './fixtures/elmercurio_b1_2026-04-25.json';

describe('groupPageArticles', () => {
  it('detects Büchi story group on B12 page (1 anchor + 4 recuadros)', () => {
    const articles = b12Fixture.articles.map((a: any) => ({
      id: a.id, title: a.title, name: a.name, width: a.width, height: a.height,
      noExport: a.noExport,
    }));
    const result = groupPageArticles(articles);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].anchor.title).toContain('Confío');
    expect(result.groups[0].recuadros).toHaveLength(4);
    // Recuadros must be sorted by recuadroIndex ascending
    const indices = result.groups[0].recuadros.map(r => parseArticleName(r.name).recuadroIndex);
    expect(indices).toEqual([1, 2, 3, 4]);
    expect(result.standalone).toHaveLength(0);
  });

  it('returns no groups on B1 page (banners + NO_WEB filtered, no recuadros)', () => {
    const articles = b1Fixture.articles.map((a: any) => ({
      id: a.id, title: a.title, name: a.name, width: a.width, height: a.height,
      noExport: a.noExport,
    }));
    const result = groupPageArticles(articles);
    expect(result.groups).toHaveLength(0);
    // Standalone: T1_EyN_B1_2504_Invariabi.ART + 2 EYN_B1_LLAMADO_*.ART (not NO_WEB)
    // Banner .AR1 is filtered. NO_WEB items filtered.
    expect(result.standalone.length).toBeGreaterThanOrEqual(2);
    expect(result.standalone.length).toBeLessThanOrEqual(4);
    // Banner must NOT appear
    expect(result.standalone.find(a => a.name.endsWith('.AR1'))).toBeUndefined();
    // NO_WEB must NOT appear
    expect(result.standalone.find(a => a.name.startsWith('NO_WEB_'))).toBeUndefined();
  });

  it('treats orphan recuadros (no anchor) as standalone', () => {
    const articles = [
      { id: 'a', title: 'orphan', name: 'T9_2_X_Foo_R1.ART', width: 1, height: 1, noExport: false },
    ];
    const result = groupPageArticles(articles);
    expect(result.groups).toHaveLength(0);
    expect(result.standalone).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    expect(groupPageArticles([])).toEqual({ groups: [], standalone: [] });
  });
});
```

(`PageArticleInfo` does not currently have `name` or `noExport` exported — we'll add those in the implementation step.)

- [ ] **Step 2:** Run tests, verify fail.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | tail -15
```

Expected: failures (`groupPageArticles` not exported, `name`/`noExport` not in `PageArticleInfo`).

- [ ] **Step 3:** Commit.

```bash
git add test/elmercurio.test.ts
git commit -m "Add failing tests for groupPageArticles"
```

### Task 4.4: Extend `PageArticleInfo` and implement `groupPageArticles`

**Files:**
- Modify: `src/extractors/elmercurio.ts`

- [ ] **Step 1:** Extend `PageArticleInfo` (around line 28):

```typescript
export interface PageArticleInfo {
  id: string;
  title: string;
  name: string;            // raw name from page JSON (e.g. "T1_EyN_B12_2504_Büchi.ART")
  width: number;
  height: number;
  noExport?: boolean;
}

export interface StoryGroup {
  anchor: PageArticleInfo;
  recuadros: PageArticleInfo[];
}

export interface PageArticleGrouping {
  groups: StoryGroup[];
  standalone: PageArticleInfo[];
}
```

- [ ] **Step 2:** Add `groupPageArticles` after `parseArticleName`:

```typescript
export function groupPageArticles(articles: PageArticleInfo[]): PageArticleGrouping {
  // Filter: must be valid .ART, not noExport, not NO_WEB_ prefix
  const valid = articles.filter(a => {
    if (!a.name) return false;
    if (a.noExport === true) return false;
    if (a.name.startsWith('NO_WEB_')) return false;
    if (!parseArticleName(a.name).isValid) return false;
    return true;
  });

  // Build index by normalizedKey for anchors (non-recuadros)
  const anchors = new Map<string, PageArticleInfo>();
  const recuadrosByKey = new Map<string, PageArticleInfo[]>();
  const looseStandalones: PageArticleInfo[] = [];

  for (const a of valid) {
    const parsed = parseArticleName(a.name);
    if (parsed.isRecuadro) {
      const arr = recuadrosByKey.get(parsed.normalizedKey) || [];
      arr.push(a);
      recuadrosByKey.set(parsed.normalizedKey, arr);
    } else {
      // Non-recuadro: candidate anchor
      anchors.set(parsed.normalizedKey, a);
    }
  }

  const groups: StoryGroup[] = [];
  const consumedAnchorKeys = new Set<string>();

  // Match anchors to recuadros
  for (const [key, recuadros] of recuadrosByKey) {
    const anchor = anchors.get(key);
    if (anchor) {
      // Sort recuadros by recuadroIndex ascending
      const sorted = recuadros.slice().sort((a, b) => {
        const ai = parseArticleName(a.name).recuadroIndex || 0;
        const bi = parseArticleName(b.name).recuadroIndex || 0;
        return ai - bi;
      });
      groups.push({ anchor, recuadros: sorted });
      consumedAnchorKeys.add(key);
    } else {
      // Orphan recuadros — treat as standalone
      looseStandalones.push(...recuadros);
    }
  }

  // Anchors not part of a group → standalone
  for (const [key, anchor] of anchors) {
    if (!consumedAnchorKeys.has(key)) {
      looseStandalones.push(anchor);
    }
  }

  // Preserve original order for standalone (use input array order)
  const orderIndex = new Map(articles.map((a, i) => [a.id, i]));
  looseStandalones.sort((a, b) => (orderIndex.get(a.id) || 0) - (orderIndex.get(b.id) || 0));

  return { groups, standalone: looseStandalones };
}
```

- [ ] **Step 3:** Update `fetchPageArticles` to populate `name` and `noExport` (around line 408):

In the `.map()` call inside `fetchPageArticles`:

```typescript
const articles: PageArticleInfo[] = (data.articles || [])
  .map((a: any) => ({
    id: a.id,
    title: (a.title || '').toString(),
    name: a.name || '',
    width: a.width || 0,
    height: a.height || 0,
    noExport: a.noExport === true,
  }))
  .filter(a => a.id && a.title);  // basic sanity
```

(We REMOVE the existing `name?.includes('NO_WEB')` filter here because `groupPageArticles` does the proper filtering. But `fetchPageArticles` is also called by callers that don't go through grouping — verify there is no other caller. Currently the only caller is `bot.ts`; we'll add grouping there in Task 4.6.)

- [ ] **Step 4:** Run tests, verify pass.

```bash
cd /Users/ji/Sites/jdv-bot && bun test test/elmercurio.test.ts 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 5:** Commit.

```bash
git add src/extractors/elmercurio.ts
git commit -m "Implement groupPageArticles + extend PageArticleInfo"
```

### Task 4.5: Implement `extractStoryGroup`

**Files:**
- Modify: `src/extractors/elmercurio.ts`

- [ ] **Step 1:** Add at the end of the file (before the existing `extract()` function):

```typescript
export async function extractStoryGroup(
  group: StoryGroup,
  date: string,
  pageId: string,
): Promise<Article> {
  // Fetch anchor + all recuadros in parallel, 8s timeout each
  const fetchOne = async (id: string): Promise<Article> => {
    const url = `https://digital.elmercurio.com/${date}/content/articles/${id}.json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${id}`);
    return await extractFromDigitalJsonResponse(await r.json(), date, id);
  };

  const [anchorRes, ...recuadroResults] = await Promise.allSettled([
    fetchOne(group.anchor.id),
    ...group.recuadros.map(r => fetchOne(r.id)),
  ]);

  if (anchorRes.status === 'rejected') {
    throw new Error(`No se pudo obtener el ancla del reportaje: ${anchorRes.reason}`);
  }
  const anchor = anchorRes.value;

  // Compose body: anchor body + each recuadro as <aside>
  let combinedBody = anchor.body;

  for (let i = 0; i < group.recuadros.length; i++) {
    const recuadroMeta = group.recuadros[i];
    const res = recuadroResults[i];
    if (res.status === 'fulfilled') {
      const r = res.value;
      const titleHtml = r.title ? `<h3>${escapeHtmlMinimal(r.title)}</h3>` : '';
      combinedBody += `\n<aside>${titleHtml}${r.body}</aside>`;
    } else {
      console.error(JSON.stringify({
        event: 'story_group_recuadro_failed',
        anchorId: group.anchor.id,
        recuadroId: recuadroMeta.id,
        error: String(res.reason),
        timestamp: new Date().toISOString(),
      }));
      const titleClean = stripTags(sanitizeMercurioMarkup(recuadroMeta.title));
      combinedBody += `\n<aside><p><i>(Recuadro «${escapeHtmlMinimal(titleClean)}» no disponible)</i></p></aside>`;
    }
  }

  // Cover image: page mid (not article photo)
  const coverImage = {
    url: `https://digital.elmercurio.com/${date}/content/pages/img/mid/${pageId}.jpg`,
  };

  // Telegraph payload size guard: if combined > 50KB, truncate last recuadros
  const sizeBytes = Buffer.byteLength(combinedBody, 'utf8');
  if (sizeBytes > 50_000) {
    console.error(JSON.stringify({
      event: 'telegraph_payload_size_warning',
      sizeBytes,
      anchorId: group.anchor.id,
      recuadroCount: group.recuadros.length,
      timestamp: new Date().toISOString(),
    }));
    // Truncate from the end: drop last <aside> blocks until under 45KB
    while (Buffer.byteLength(combinedBody, 'utf8') > 45_000) {
      const lastAside = combinedBody.lastIndexOf('<aside>');
      if (lastAside === -1) break;
      combinedBody = combinedBody.slice(0, lastAside).trimEnd() +
        '\n<p><i>(Continúa en el original →)</i></p>';
    }
  }

  return {
    title: anchor.title,
    kicker: anchor.kicker,
    subtitle: anchor.subtitle,
    author: anchor.author,
    body: combinedBody,
    images: anchor.images,
    coverImage,
    url: `https://digital.elmercurio.com/${date}/content/articles/${group.anchor.id}`,
    source: 'elmercurio',
  };
}

// Minimal HTML escape for embedding into innerHTML
function escapeHtmlMinimal(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 2:** Refactor `extractFromDigitalJson` to expose a pure function from response-data, so `extractStoryGroup` can reuse it without doing a second fetch.

Replace `extractFromDigitalJson` (around line 167):

```typescript
async function extractFromDigitalJson(date: string, articleId: string): Promise<Article> {
  const jsonUrl = `https://digital.elmercurio.com/${date}/content/articles/${articleId}.json`;
  const response = await fetch(jsonUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Error al obtener artículo: ${response.status}`);
  return extractFromDigitalJsonResponse(await response.json(), date, articleId);
}

function extractFromDigitalJsonResponse(
  data: MercurioJsonArticle,
  date: string,
  articleId: string,
): Article {
  const rawTitle = data.title || data.head;
  if (!rawTitle) throw new Error('Artículo sin título');
  const title = stripTags(sanitizeMercurioMarkup(rawTitle));

  const kicker = data.head_label
    ? stripTags(sanitizeMercurioMarkup(data.head_label))
    : undefined;
  const subtitle = data.head_deck
    ? stripTags(sanitizeMercurioMarkup(data.head_deck))
    : undefined;
  const author = data.byline
    ? stripTags(sanitizeMercurioMarkup(data.byline)).replace(/^Por\s+/i, '').trim()
    : undefined;

  const quoteBlocks = (data.quotes || [])
    .map(q => sanitizeMercurioMarkup(q.quote || ''))
    .filter(Boolean)
    .map(q => `<blockquote>${q}</blockquote>`)
    .join('\n');

  const sanitizedBody = sanitizeMercurioMarkup(data.body || '');
  const body = quoteBlocks ? `${quoteBlocks}\n${sanitizedBody}` : sanitizedBody;

  const images = (data.images || [])
    .filter(img => img.noExport === false && img.infographic === false && img.path)
    .map(img => {
      const url = `https://digital.elmercurio.com/${date}/content/pages/img/mid/${img.path}`;
      let caption = img.caption ? stripTags(sanitizeMercurioMarkup(img.caption)) : undefined;
      if (img.credits) {
        caption = caption ? `${caption} (Foto: ${img.credits})` : `Foto: ${img.credits}`;
      }
      return { url, caption };
    });

  return {
    title,
    kicker,
    subtitle,
    author,
    body,
    images: images.length > 0 ? images : undefined,
    url: `https://digital.elmercurio.com/${date}/content/articles/${articleId}`,
    source: 'elmercurio',
  };
}
```

- [ ] **Step 3:** Verify TypeScript compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/extractors/elmercurio.ts
git commit -m "Implement extractStoryGroup with parallel fetch + size guard"
```

### Task 4.6: Update bot.ts callback handling for groups vs articles

**Files:**
- Modify: `src/bot.ts`

- [ ] **Step 1:** Update `PendingPageSelection` to support groups.

Replace the interface (around line 172):

```typescript
interface PendingPageSelection {
  groups: StoryGroup[];           // detected story groups
  standalone: PageArticleInfo[];  // ungrouped articles
  date: string;
  pageId: string;                 // for cover image
  originalUrl: string;
  userId: number;
  username?: string;
  firstName: string;
  chatId: number;
  botMessageId: number;
  originalMessageId: number;
  originalText: string;
  replyToMessageId?: number;
  threadId?: number;
  replyTargetThreadId?: number;
  replyTargetIsBot?: boolean;
}
```

Update the import:

```typescript
import {
  isPageUrl,
  fetchPageArticles,
  extractByArticleId,
  extractStoryGroup,
  groupPageArticles,
  sanitizeMercurioMarkup,
  type PageArticleInfo,
  type StoryGroup,
} from './extractors/elmercurio.js';
```

- [ ] **Step 2:** Update `fetchPageArticles` return shape used in `bot.ts`.

`fetchPageArticles` currently returns `{articles, date, sectionName, page}`. We need it to also expose `pageId`. Update its return type in `elmercurio.ts` first (find around line 408):

```typescript
export async function fetchPageArticles(url: string): Promise<{
  articles: PageArticleInfo[];
  date: string;
  pageId: string;
  sectionName: string;
  page: number;
} | null> {
  const parsed = parseUrl(url);
  if (!parsed || parsed.type !== 'digital-page' || !parsed.pageId || !parsed.date) {
    return null;
  }

  const pageUrl = `https://digital.elmercurio.com/${parsed.date}/content/pages/${parsed.pageId}.json`;
  const response = await fetch(pageUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;

  const data = await response.json();

  const articles: PageArticleInfo[] = (data.articles || [])
    .map((a: any) => ({
      id: a.id,
      title: (a.title || '').toString(),
      name: a.name || '',
      width: a.width || 0,
      height: a.height || 0,
      noExport: a.noExport === true,
    }))
    .filter((a: PageArticleInfo) => a.id && a.title);

  return {
    articles,
    date: parsed.date,
    pageId: parsed.pageId,
    sectionName: data.category_name || data.section_name || '',
    page: data.page || 0,
  };
}
```

- [ ] **Step 3:** Replace the page-selection block in `bot.ts` (around line 1210-1284).

Replace the entire `if (source === 'elmercurio' && isPageUrl(url)) { ... }` block with:

```typescript
if (source === 'elmercurio' && isPageUrl(url)) {
  try {
    const pageData = await fetchPageArticles(url);
    if (!pageData || pageData.articles.length === 0) {
      const sent = await ctx.reply('❌ No encontré artículos en esa página.', {
        reply_to_message_id: ctx.message.message_id,
      });
      scheduleDelete(ctx.api, sent.chat.id, sent.message_id);
      continue;
    }

    const grouping = groupPageArticles(pageData.articles);

    console.log(JSON.stringify({
      event: 'page_groups_detected',
      url,
      groupCount: grouping.groups.length,
      standaloneCount: grouping.standalone.length,
      totalArticles: pageData.articles.length,
      timestamp: new Date().toISOString(),
    }));

    // AUTO: 1 group + 0 standalones → render group without prompting
    if (grouping.groups.length === 1 && grouping.standalone.length === 0) {
      const article = await extractStoryGroup(grouping.groups[0], pageData.date, pageData.pageId);
      article.url = url;
      const result = await createPage(article);
      const cacheKey = `${url}#group:${grouping.groups[0].anchor.id}`;
      cache.set(cacheKey, { result, expires: Date.now() + TTL });
      pathToUrl.set(result.path, url);
      addRegistryEntry({
        type: 'extractor', originalUrl: url, source: article.source,
        telegraphPath: result.path, title: article.title, chatId: ctx.chat?.id,
      }).catch(() => {});
      await processAndReply(ctx, url, result);
      continue;
    }

    // AUTO: 0 groups + 1 standalone → render directly (existing behavior)
    if (grouping.groups.length === 0 && grouping.standalone.length === 1) {
      const article = await extractByArticleId(grouping.standalone[0].id, pageData.date);
      article.url = url;
      const result = await createPage(article);
      cache.set(`${url}#${grouping.standalone[0].id}`, { result, expires: Date.now() + TTL });
      pathToUrl.set(result.path, url);
      addRegistryEntry({
        type: 'extractor', originalUrl: url, source: article.source,
        telegraphPath: result.path, title: article.title, chatId: ctx.chat?.id,
      }).catch(() => {});
      await processAndReply(ctx, url, result);
      continue;
    }

    // Otherwise: show selector with groups + standalones
    let text = `📰 <b>${escapeHtml(pageData.sectionName)}</b> — Pág. ${pageData.page}\n\n`;
    text += 'Elige el artículo:\n\n';
    const keyboard = new InlineKeyboard();

    // Groups first
    for (let gi = 0; gi < grouping.groups.length; gi++) {
      const g = grouping.groups[gi];
      const cleanTitle = sanitizeMercurioMarkup(g.anchor.title)
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const partsCount = 1 + g.recuadros.length;
      text += `📋 Reportaje completo: ${escapeHtml(cleanTitle)} (${partsCount} partes)\n`;
      keyboard.text(`📋 ${gi + 1}`, `empage:g:${gi}`).row();
    }

    // Standalones with numbered buttons
    const maxStandalone = Math.min(grouping.standalone.length, NUMBER_EMOJIS.length);
    for (let i = 0; i < maxStandalone; i++) {
      const a = grouping.standalone[i];
      const cleanTitle = sanitizeMercurioMarkup(a.title)
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      text += `${NUMBER_EMOJIS[i]} ${escapeHtml(cleanTitle)}\n`;
      keyboard.text(NUMBER_EMOJIS[i], `empage:a:${i}`);
      if ((i + 1) % 5 === 0) keyboard.row();
    }

    const botMessage = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      reply_to_message_id: ctx.message.message_id,
    });

    pendingPages.set(botMessage.message_id, {
      groups: grouping.groups,
      standalone: grouping.standalone.slice(0, maxStandalone),
      date: pageData.date,
      pageId: pageData.pageId,
      originalUrl: url,
      userId: ctx.from?.id || 0,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name || 'Usuario',
      chatId: ctx.chat.id,
      botMessageId: botMessage.message_id,
      originalMessageId: ctx.message.message_id,
      originalText: ctx.message.text,
      replyToMessageId: ctx.message.reply_to_message?.message_id,
      threadId: ctx.message.message_thread_id,
      replyTargetThreadId: ctx.message.reply_to_message?.message_thread_id,
      replyTargetIsBot: ctx.message.reply_to_message?.from?.is_bot ?? false,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'page_selection_error', url,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    const sent = await ctx.reply('❌ No pude acceder a esa página.', {
      reply_to_message_id: ctx.message.message_id,
    });
    scheduleDelete(ctx.api, sent.chat.id, sent.message_id);
  }
  continue;
}
```

- [ ] **Step 4:** Update the callback handler (around line 1819-1864). Replace the `if (data.startsWith('empage:'))` block with branching for `g:` (group) vs `a:` (article):

```typescript
if (data.startsWith('empage:')) {
  const messageId = ctx.callbackQuery.message?.message_id;
  if (!messageId) {
    await ctx.answerCallbackQuery({ text: 'Error interno' });
    return;
  }

  const sel = pendingPages.get(messageId);
  if (!sel) {
    await ctx.answerCallbackQuery({ text: 'Selección expirada. Pega la URL de nuevo.', show_alert: true });
    return;
  }

  // Authorization check (unchanged)
  const isOwner = ctx.from?.id === sel.userId;
  let isAdmin = false;
  if (!isOwner && ctx.chat && ctx.from?.id) {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      isAdmin = ['creator', 'administrator'].includes(member.status);
    } catch {}
  }
  if (!isOwner && !isAdmin) {
    await ctx.answerCallbackQuery({ text: 'Solo quien pegó la URL puede elegir' });
    return;
  }

  // Parse callback: empage:g:N or empage:a:N
  const m = data.match(/^empage:([ga]):(\d+)$/);
  if (!m) {
    await ctx.answerCallbackQuery({ text: 'Selección no válida' });
    return;
  }
  const kind = m[1];
  const idx = parseInt(m[2], 10);

  let extracted: Article;
  let cacheKey: string;
  try {
    if (kind === 'g') {
      const group = sel.groups[idx];
      if (!group) {
        await ctx.answerCallbackQuery({ text: 'Grupo no válido' });
        return;
      }
      pendingPages.delete(messageId);
      await ctx.answerCallbackQuery({ text: '⏳ Procesando reportaje...' });
      await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando reportaje...');
      extracted = await Promise.race([
        extractStoryGroup(group, sel.date, sel.pageId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30_000)),
      ]);
      cacheKey = `${sel.originalUrl}#group:${group.anchor.id}`;
    } else {
      const article = sel.standalone[idx];
      if (!article) {
        await ctx.answerCallbackQuery({ text: 'Artículo no válido' });
        return;
      }
      pendingPages.delete(messageId);
      await ctx.answerCallbackQuery({ text: '⏳ Procesando...' });
      await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '⏳ Procesando artículo...');
      extracted = await Promise.race([
        extractByArticleId(article.id, sel.date),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30_000)),
      ]);
      cacheKey = `${sel.originalUrl}#${article.id}`;
    }
    extracted.url = sel.originalUrl;
    const result = await createPage(extracted);
    cache.set(cacheKey, { result, expires: Date.now() + TTL });
    pathToUrl.set(result.path, sel.originalUrl);

    // Build final message (same as before)
    const keyboard = createActionKeyboard(result.path, sel.userId, sel.originalUrl);
    const mention = sel.username ? `@${sel.username}` :
      `<a href="tg://user?id=${sel.userId}">${escapeHtml(sel.firstName)}</a>`;
    const extraText = getTextWithoutUrls(sel.originalText);
    const messageText = extraText
      ? `${mention}: ${escapeHtml(extraText)}\n\n${result.url}`
      : `${mention} compartió:\n${result.url}`;

    if (sel.replyToMessageId) {
      // ... preserve the reply-handling branch from the original code
      // (copy lines 1879-1920 from old code unchanged)
    } else {
      // ... non-reply branch
      // (copy lines 1921-1940 from old code unchanged)
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: 'page_extraction_error',
      url: sel.originalUrl,
      kind, idx,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    try {
      await ctx.api.editMessageText(sel.chatId, sel.botMessageId, '❌ No pude reconstruir el artículo.');
    } catch {}
  }
  return;
}
```

**Note:** preserve the exact reply/non-reply branches from the existing code (lines 1879-1940). Read those lines first and copy them verbatim into the placeholders above. Do NOT rewrite that logic.

- [ ] **Step 5:** Verify TypeScript compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6:** Run all tests, verify pass.

```bash
cd /Users/ji/Sites/jdv-bot && bun test 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 7:** Commit.

```bash
git add src/bot.ts src/extractors/elmercurio.ts
git commit -m "Wire story group selector + auto-merge in bot.ts"
```

---

## Phase 5: Cover de página en Telegraph

Already implemented for groups in Task 4.5 (uses `pages/img/mid/{pageId}.jpg`). Skip — keep numbering for spec traceability.

---

## Phase 6: LUN video (optional)

### Task 6.1: Add video to LUN body when present

**Files:**
- Modify: `src/extractors/lun.ts`

- [ ] **Step 1:** Add capture of `<div id="video">` in `extractLunContent`.

After the `autor` extraction:

```typescript
// Video filename from div id="video"
let videoFilename: string | null = null;
m = html.match(/<div id="video">([^<]+)<\/div>/);
if (m) videoFilename = m[1].trim();
```

- [ ] **Step 2:** Return it from `extractLunContent`. Add `videoUrl: string | null` to `ExtractedContent` and set:

```typescript
result.videoUrl = videoFilename
  ? `https://images.lun.com/luncontents/Videos/${videoFilename}`
  : null;
```

- [ ] **Step 3:** In the main `extract()` function, prepend to body:

```typescript
let body = '';
if (content.videoUrl) {
  body += `<figure><video src="${content.videoUrl}"></video></figure>\n`;
}
if (content.subtitulo) {
  body += `<p><strong>${content.subtitulo}</strong></p>\n`;
}
// ... rest unchanged
```

- [ ] **Step 4:** Verify compiles.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5:** Commit.

```bash
git add src/extractors/lun.ts
git commit -m "Embed LUN video as <video> node when present"
```

---

## Final verification

### Task F.1: Smoke test against live URLs

- [ ] **Step 1:** Run all unit tests.

```bash
cd /Users/ji/Sites/jdv-bot && bun test 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 2:** Type-check the whole project.

```bash
cd /Users/ji/Sites/jdv-bot && bun tsc --noEmit 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 3:** Manual smoke (requires `TELEGRAM_BOT_TOKEN` and `TELEGRAPH_ACCESS_TOKEN` set):

Send these URLs to the bot in a test chat and verify:

| URL | Expected behavior |
|-----|-------------------|
| `https://digital.elmercurio.com/2026/04/25/B/3A4KSPJP` | Auto-renders single Telegraph with kicker "Antonio Büchi…", 2 quotes, anchor body, 4 recuadros as `<aside>`, page cover image. NO selector shown. |
| `https://digital.elmercurio.com/2026/04/25/B/3A4KSPGH` | Selector shown with 2-4 standalone items (no banners, no NO_WEB) |
| `https://www.lun.com/Pages/NewsDetail.aspx?dt=2026-04-26&EsAviso=0&PaginaId=13&bodyid=0` | Telegraph includes "Francisca Orellana" as author, page cover from `pages/p_2026-04-26_pag13.webp` |

- [ ] **Step 4:** If smoke succeeds, the implementation is done.

---

## Self-review checklist

| Spec section | Tasks |
|---|---|
| Sanitizer whitelist for Mercurio markup | 1.3, 1.4 |
| Kicker extraction | 1.1, 1.2, 1.5 |
| Quotes extraction | 1.5 |
| Mercurio image with caption + credits | 1.5 |
| Sanitize selector titles | 1.6 |
| LUN author | 3.5 |
| LUN page cover | 3.3, 3.4, 3.5 |
| LUN bajada/volada | (already in current code; covered by 3.5 author addition) |
| Story group detection | 4.1-4.4 |
| extractStoryGroup with parallel fetch | 4.5 |
| Auto-merge single group | 4.6 |
| Selector with groups + standalones | 4.6 |
| Telegraph payload size guard | 4.5 |
| LUN video (optional) | 6.1 |
| Page cover in Telegraph | 4.5 (Mercurio), 3.5 (LUN) |
| Logging events | 4.5 (story_group_recuadro_failed, telegraph_payload_size_warning), 4.6 (page_groups_detected, page_extraction_error) |
| Tests for all units | 0.2, 1.3, 3.3, 4.1, 4.3 |
