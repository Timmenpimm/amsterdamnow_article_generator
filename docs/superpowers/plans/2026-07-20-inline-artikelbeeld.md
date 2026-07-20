# Inline-artikelbeeld + slider naar 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Verdeel de 3 artikelbeelden als featured + 1 slider + 1 inline (tussen
alinea 2 en 3), i.p.v. featured + 2 slider — inclusief auto-fill, handmatige UI
en een backfill voor bestaande niet-gepubliceerde concepten.

**Architecture:** Het inline-beeld leeft ín de content-HTML als
`<figure class="an-inline"><img class="wp-image-<id>" src=…></figure>`, precies
zoals lijstartikel-itemfoto's al in de content staan. `mapPost` leest het terug
uit de content; `spliceInlineImage()` zet/vervangt/verwijdert het. Geen
WordPress/ACF-config nodig.

**Tech Stack:** Next.js (app router), TypeScript, geen Tailwind (inline styles +
utility-classes), db-laag SQLite/Postgres, WordPress REST in LIVE-modus.

## Global Constraints

- **Geen testrunner** (bewust). Verificatie per taak: `cd app && npx tsc --noEmit`
  en waar relevant `curl`/preview op poort 3400 (demo/SQLite). Volledige
  bouwcheck (`npx next build`) in de laatste taak.
- **Stijl** (DESIGN-MAP §3): geen Tailwind; inline `style={{…}}` met `var(--token)`
  + bestaande utility-classes. Nieuwe slots kopiëren het bestaande slot-patroon.
- **API-routes** (DESIGN-MAP §4): `export const dynamic = 'force-dynamic'`,
  `NextResponse.json`, `[id]` uit `await params`. Nieuwe geneste route → eigen
  rewrite in `vercel.json` vóór de catch-all, statische segmenten eerst.
- **`REQUIRED_IMAGES` blijft 3.** Totaal = featured + slider + inline (+ items).
- Inline-marker exact: wrapper `<figure class="an-inline">`, img-class
  `wp-image-<mediaId>`. Deze twee strings zijn de contracten tussen splice/parse.
- Werk op branch `feat/inline-article-image`; commit per taak.

---

### Task 1: Datamodel — `inline` op Article + imageCount

**Files:**
- Modify: `app/lib/types.ts`

**Interfaces:**
- Produces: `Article.inline: MediaRef | null`; `imageCount()` telt inline mee.

- [ ] **Step 1: Voeg `inline` toe aan de `Article`-interface**, direct onder
  `slider: MediaRef[];`:

```ts
  slider: MediaRef[];
  inline: MediaRef | null;
```

- [ ] **Step 2: Werk `imageCount()` bij** zodat inline meetelt:

```ts
export function imageCount(a: Pick<Article, 'featured' | 'slider' | 'inline'>, list?: ListArticleStructure | null): number {
  const itemImages = list ? list.items.filter(i => i.media).length : 0;
  return (a.featured ? 1 : 0) + a.slider.length + (a.inline ? 1 : 0) + itemImages;
}
```

- [ ] **Step 3: Typecheck** — `cd app && npx tsc --noEmit`. Verwacht: fouten in
  `wp.ts`/`demo-seed.ts` omdat `inline` nog ontbreekt in objectliterals. Die lost
  Task 2/3 op. Geen fouten in `types.ts` zelf.

- [ ] **Step 4: Commit**

```bash
git add app/lib/types.ts
git commit -m "feat(types): add inline image field to Article"
```

---

### Task 2: `wp.ts` — splice-helper, parse, updateImages, createDraft

**Files:**
- Modify: `app/lib/wp.ts`

**Interfaces:**
- Produces: `spliceInlineImage(html: string, media: MediaRef | null): string`
- Consumes: `Article.inline` (Task 1).
- `updateImages(id, upd, known)` — `ImageUpdate` krijgt `inlineId?: number | null`.

- [ ] **Step 1: Voeg de splice-helper toe** (bovenaan bij de andere helpers).
  Regex-gebaseerd (Node-omgeving; geen DOM):

```ts
// Het inline-artikelbeeld leeft ín de content-HTML als een gemarkeerde figure,
// net als itemfoto's bij lijstartikelen. Deze helper is de enige plek die die
// markup schrijft; mapPost leest 'm terug.
const INLINE_FIGURE_RE = /\s*<figure class="an-inline">[\s\S]*?<\/figure>/i;

export function spliceInlineImage(html: string, media: MediaRef | null): string {
  const stripped = (html || '').replace(INLINE_FIGURE_RE, '');
  if (!media) return stripped;
  const fig = `<figure class="an-inline"><img class="wp-image-${media.id}" src="${media.url}" alt="" /></figure>`;
  // Zoek de sluit-tag van de 2e top-level alinea; plaats de figure erna.
  const closes: number[] = [];
  const re = /<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) closes.push(m.index + m[0].length);
  if (closes.length >= 3) {
    const at = closes[1]; // na de 2e </p>
    return stripped.slice(0, at) + '\n' + fig + stripped.slice(at);
  }
  // < 3 alinea's → achteraan.
  return stripped.trimEnd() + '\n' + fig;
}
```

- [ ] **Step 2: Parse het inline-beeld terug in `mapPost`.** Voeg een helper toe
  en zet `inline` op het teruggegeven object. Zoek de bestaande `mapPost` (rond
  regel 100-135, waar `featured`/`slider` gezet worden) en voeg toe:

```ts
function parseInline(contentHtml: string): MediaRef | null {
  const fig = contentHtml.match(INLINE_FIGURE_RE);
  if (!fig) return null;
  const idM = fig[0].match(/wp-image-(\d+)/);
  const srcM = fig[0].match(/src="([^"]+)"/);
  if (!idM || !srcM) return null;
  return { id: Number(idM[1]), url: srcM[1] };
}
```

  En in `mapPost`, waar het Article-object wordt samengesteld, voeg het veld toe
  (de content-HTML-variabele in mapPost heet `content`/`p.content?.rendered` —
  gebruik dezelfde die aan `contentHtml` wordt toegekend):

```ts
    inline: parseInline(<de content-html die mapPost al gebruikt>),
```

- [ ] **Step 3: Breid `ImageUpdate` + `updateImages` uit.** Voeg
  `inlineId?: number | null;` toe aan het `ImageUpdate`-interface. In de
  **demo-tak** van `updateImages`:

```ts
    if (upd.inlineId !== undefined) a.inline = upd.inlineId == null ? null : pool.get(upd.inlineId) || null;
    if (upd.inlineId !== undefined) a.contentHtml = spliceInlineImage(a.contentHtml, a.inline);
```

  (plaats dit ná de bestaande featured/slider-toewijzingen, vóór `demoSave`.)

  In de **LIVE-tak** van `updateImages` (waar `body.featured_media`/`body.acf`
  gezet worden en daarna `wpFetch(...POST...)`): resolve de MediaRef en zet de
  content mee:

```ts
  if (upd.inlineId !== undefined) {
    const cur = await wpFetch(`/wp/v2/posts/${id}?context=edit&_fields=content`);
    const media = upd.inlineId == null ? null : (known.find(m => m.id === upd.inlineId) || null);
    body.content = spliceInlineImage(cur?.content?.raw ?? cur?.content?.rendered ?? '', media);
  }
```

  (LET OP: `?context=edit` levert `content.raw`; val terug op `.rendered`.)

- [ ] **Step 4: `createDraft` — demo-object krijgt `inline: null`.** Zoek in de
  demo-tak van `createDraft` het `Article`-literal (met `featured: null, slider: []`)
  en voeg `inline: null` toe.

- [ ] **Step 5: Typecheck** — `cd app && npx tsc --noEmit`. Verwacht: nog fouten
  in `demo-seed.ts` (Task 3). `wp.ts` zelf foutloos.

- [ ] **Step 6: Commit**

```bash
git add app/lib/wp.ts
git commit -m "feat(wp): inline image splicing, parsing and updateImages support"
```

---

### Task 3: Plumbing — demo-seed, PATCH-route, media-route

**Files:**
- Modify: `app/lib/demo-seed.ts`
- Modify: `app/app/api/articles/[id]/route.ts`
- Modify: `app/app/api/articles/[id]/media/route.ts`

**Interfaces:**
- Consumes: `updateImages` met `inlineId` (Task 2).

- [ ] **Step 1: demo-seed — `inline: null` op elk seed-artikel.** Elk object in
  de seed-array heeft `featured`/`slider`; voeg overal `inline: null` toe. (Één
  seed mag een demonstratief inline-beeld krijgen door zijn `contentHtml` een
  `<figure class="an-inline">…</figure>` na de 2e alinea te geven én
  `inline: { id, url }` te zetten — optioneel.)

- [ ] **Step 2: PATCH-route geeft `inlineId` door.** In
  `app/app/api/articles/[id]/route.ts`, in de `updateImages`-aanroep:

```ts
    const article = await updateImages(
      Number(id),
      { featuredId: body.featuredId, sliderIds: body.sliderIds, inlineId: body.inlineId, fotograaf: body.fotograaf },
      body.knownMedia || []
    );
```

- [ ] **Step 3: media-route verwerkt `role=inline`.** In
  `app/app/api/articles/[id]/media/route.ts`: het eerste geüploade beeld met
  `role === 'inline'` wordt inline gezet i.p.v. slider. Pas de plaatsingslus aan:

```ts
    let featuredId = article.featured?.id ?? null;
    let inlineId = article.inline?.id ?? null;
    const sliderIds = article.slider.map(m => m.id);
    for (const m of uploaded) {
      if (role === 'featured' && m === uploaded[0]) {
        if (featuredId && !sliderIds.includes(featuredId)) sliderIds.push(featuredId);
        featuredId = m.id;
      } else if (role === 'inline' && m === uploaded[0]) {
        inlineId = m.id;
      } else if (role !== 'featured' && role !== 'inline' && featuredId == null && role !== 'slider') {
        featuredId = m.id;
      } else {
        sliderIds.push(m.id);
      }
    }
    const updated = await updateImages(Number(id), { featuredId, sliderIds, inlineId }, [...uploaded, ...(article.featured ? [article.featured] : []), ...article.slider, ...(article.inline ? [article.inline] : [])]);
```

  En werk de doc-comment bovenaan bij (`?role=featured|slider|inline`).

- [ ] **Step 4: Typecheck** — `cd app && npx tsc --noEmit`. Verwacht: schoon.

- [ ] **Step 5: Commit**

```bash
git add app/lib/demo-seed.ts app/app/api/articles/
git commit -m "feat(api): plumb inlineId through PATCH + media routes; seed inline"
```

---

### Task 4: Auto-fill — featured + 1 slider + 1 inline

**Files:**
- Modify: `app/app/api/articles/[id]/candidates/autofill/route.ts`

- [ ] **Step 1: Wijzig de plaatsing.** De `uploaded`-lijst blijft (max 3, dode
  URL's overslaan). Vervang het `updateImages`-blok onderaan door
  featured=[0], slider=[1], inline=[2]:

```ts
    const best = uploaded[0].candidate;
    const credit = [best.author, best.source, best.license].filter(Boolean).join(' · ');
    const updated = await updateImages(
      article.id,
      {
        featuredId: uploaded[0].media.id,
        sliderIds: uploaded[1] ? [uploaded[1].media.id] : [],
        inlineId: uploaded[2] ? uploaded[2].media.id : undefined,
        ...(article.fotograaf ? {} : { fotograaf: credit }),
      },
      uploaded.map(u => u.media)
    );
```

- [ ] **Step 2: Werk de doc-comment bovenaan bij** ("featured + 2 slider" →
  "featured + 1 slider + 1 inline", voorrang Featured → Slider → Inline).

- [ ] **Step 3: Typecheck** — `cd app && npx tsc --noEmit`. Verwacht: schoon.

- [ ] **Step 4: Commit**

```bash
git add app/app/api/articles/\[id\]/candidates/autofill/route.ts
git commit -m "feat(autofill): place featured + 1 slider + 1 inline"
```

---

### Task 5: Beeldwerk-UI — inline-slot + slider naar 1

**Files:**
- Modify: `app/components/ArticleDetail.tsx`

**Interfaces:**
- Consumes: media-route `?role=inline`, PATCH `inlineId`, `article.inline`.

- [ ] **Step 1: `UploadTarget` + `allMedia`.** Breid het type uit:
  `type UploadTarget = 'featured' | 'slider' | 'inline' | number;`
  en neem inline mee in `allMedia`:
  `return [...(a.featured ? [a.featured] : []), ...a.slider, ...(a.inline ? [a.inline] : [])];`

- [ ] **Step 2: slider-doel naar 1.** Vervang
  `const sliderMissing = Math.max(0, 2 - article.slider.length);` door
  `Math.max(0, 1 - article.slider.length);` en pas de sliderkop-teksten aan
  ("minimaal 2 foto's" → "1 foto", en de teller-tekst dienovereenkomstig).

- [ ] **Step 3: Nieuw slot "3 · Inline in tekst".** Kopieer het **featured**-slot
  (enkel beeld, niet de slider-lijst) direct ná het slider-blok en pas aan:
  - Kop: `3 · Inline in tekst`, subtekst `verschijnt tussen alinea 2 en 3`.
  - Status-chip: `article.inline ? '✓ gevuld' : 'nog leeg'`.
  - Gevuld: `<img src={article.inline.url} …/>` met overlay-knoppen:
    - "Vervangen" → `pickFiles('inline')`
    - "Verwijderen" → `patch({ inlineId: null })`
    - "→ naar slider" → `patch({ inlineId: null, sliderIds: [...article.slider.map(m=>m.id), article.inline!.id] })`
  - Leeg: `<DropSlot>` met `role='inline'` → `uploadFiles(files,'inline')`,
    `onClick={() => pickFiles('inline')}`, `onUrl={() => uploadUrl('inline')}`.
  - Kruis-knoppen in featured/slider die naar inline verplaatsen: bij een
    sliderbeeld een knop "→ inline" → `patch({ sliderIds: rest, inlineId: m.id })`.

- [ ] **Step 4: Hernummer** de kandidaten-sectiekop van "3 · …" naar "4 · …"
  (standaardartikel). Zoek de sectiekop met "Voorgestelde beelden" en verhoog
  het nummer; bij lijstartikelen telt de bestaande nummering al mee.

- [ ] **Step 5: Kandidaat-plaatsing naar inline.** In de functie die een
  kandidaat in een slot zet (rond regel 134-163, `target`), zorg dat
  `target === 'inline'` de endpoint `/api/articles/${id}/media?role=inline`
  raakt en de juiste toast toont. `CandidateCard` krijgt een actie `+ Inline`
  naast `★ Featured` / `+ Slider`.

- [ ] **Step 6: Typecheck** — `cd app && npx tsc --noEmit`. Verwacht: schoon.

- [ ] **Step 7: Preview-verificatie (demo/SQLite).** `mv app/.env app/.env.disabled`
  (§5), start preview `artikel-tool`, open een artikel-detail:
  - inline-slot vullen via URL, verschijnt tussen alinea 2/3 in de content-preview;
  - vervangen, verwijderen, en wisselen slider↔inline werkt;
  - slider vraagt nog om 1 beeld.
  Zet daarna `app/.env` terug.

- [ ] **Step 8: Commit**

```bash
git add app/components/ArticleDetail.tsx
git commit -m "feat(ui): inline image slot, slider target 1, renumber sections"
```

---

### Task 6: Backfill-endpoint bestaande concepten

**Files:**
- Create: `app/app/api/admin/backfill-inline/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `listArticles()`, `updateImages` met `inlineId`.

- [ ] **Step 1: Maak de route.** Beveiligd met `Bearer CRON_SECRET`, alleen
  niet-gepubliceerde concepten met ≥2 slider en geen inline, laatste slider →
  inline, max 8 per tik, idempotent:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { listArticles, updateImages } from '@/lib/wp';

export const dynamic = 'force-dynamic';

const MAX_PER_TICK = 8;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const articles = await listArticles();
    const todo = articles.filter(a => a.status !== 'publish' && a.slider.length >= 2 && !a.inline);
    const batch = todo.slice(0, MAX_PER_TICK);
    const changed: { id: number; title: string }[] = [];
    for (const a of batch) {
      const last = a.slider[a.slider.length - 1];
      await updateImages(
        a.id,
        { sliderIds: a.slider.slice(0, -1).map(m => m.id), inlineId: last.id },
        [...a.slider, ...(a.featured ? [a.featured] : [])]
      );
      changed.push({ id: a.id, title: a.title });
    }
    return NextResponse.json({ done: todo.length <= MAX_PER_TICK, changed, remaining: Math.max(0, todo.length - batch.length) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: `vercel.json` rewrite.** Voeg vóór de catch-all `/(.*)` een
  rewrite toe voor `/api/admin/backfill-inline` (statisch segment, geen `[id]`).
  Kopieer het patroon van een bestaande niet-dynamische API-rewrite in het bestand.

- [ ] **Step 3: Typecheck** — `cd app && npx tsc --noEmit`. Verwacht: schoon.

- [ ] **Step 4: Verificatie (demo/SQLite).** Met preview draaiend en een
  demo-concept dat 2 sliderbeelden heeft:
  `curl -XPOST -H "Authorization: Bearer $CRON_SECRET" localhost:3400/api/admin/backfill-inline`
  (zet lokaal een `CRON_SECRET`), verwacht `{done:true, changed:[…]}`; her-run →
  `changed:[]`. Gepubliceerde ongemoeid.

- [ ] **Step 5: Commit**

```bash
git add app/app/api/admin/backfill-inline/route.ts vercel.json
git commit -m "feat(backfill): endpoint to convert last slider to inline for concepts"
```

---

### Task 7: DESIGN-MAP + volledige bouwcheck

**Files:**
- Modify: `docs/DESIGN-MAP.md`

- [ ] **Step 1: Werk DESIGN-MAP §2 bij** — bij scherm **1c** het inline-slot en
  de backfill-route noemen; datum-regel bijwerken.

- [ ] **Step 2: Volledige bouwcheck** — `cd app && npx tsc --noEmit && npx next build`.
  Verwacht: build slaagt.

- [ ] **Step 3: Commit + PR**

```bash
git add docs/DESIGN-MAP.md
git commit -m "docs: update design map for inline image slot"
git push -u origin feat/inline-article-image
gh pr create --title "Inline-artikelbeeld + slider naar 1" --body "…"
```

## Self-Review

- **Spec-dekking:** datamodel (T1), splice/parse/updateImages (T2), plumbing
  (T3), auto-fill (T4), UI + slider→1 (T5), backfill (T6), DESIGN-MAP (T7). Alle
  spec-secties gedekt.
- **Contract-consistentie:** marker `<figure class="an-inline">` + `wp-image-<id>`
  identiek in `spliceInlineImage`, `parseInline` en `INLINE_FIGURE_RE`.
  `inlineId` identiek in `ImageUpdate`, PATCH-route, media-route, autofill,
  backfill.
- **Geen testrunner:** verificatie via tsc/next build + curl/preview, expliciet
  per taak.
