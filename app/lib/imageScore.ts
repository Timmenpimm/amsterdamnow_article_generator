import { askClaudeJsonWithImages, ClaudeImage } from './claude';
import { scoreImageCandidate } from './db';
import type { Article, ImageCandidate } from './types';

// Beeldstijlprofiel van amsterdamnow.com, vastgesteld door de site te
// screenen (juli 2026): warm, fotografisch, on location. Zie
// docs/superpowers/specs/2026-07-20-beeldselectie-design.md.
const STYLE_SYSTEM = `Je bent de beeldredacteur van AmsterdamNOW, een city guide over Amsterdam.
Je beoordeelt kandidaat-beelden voor een artikel. De beeldstijl van de site:

- Fotografisch en realistisch. Illustraties, renders, posters, logo's, collages en screenshots zijn altijd 0 punten.
- Warm en levendig: natuurlijk licht of sfeervol interieurlicht, het "avondje uit"-gevoel. Kille stockfoto-sfeer scoort laag.
- Typische onderwerpen: interieur van de zaak, terras of gevel, gerecht in close-up met ondiepe scherptediepte, mensen die de plek echt gebruiken (niet poserend recht in de camera), event- of tentoonstellingsbeeld, straatbeeld van de buurt.
- Specifiek wint van generiek: het genoemde venue of event zelf > de genoemde buurt > herkenbaar Amsterdam > generiek thema. Een beeld dat herkenbaar een ándere stad of een ander land toont is 0 punten.
- Het beeld moet bruikbaar zijn liggend én als vierkante crop: onderwerp niet tegen de rand geplakt.
- Watermerken, tekst-overlays, zichtbare compressie of gedateerde beelden (oude auto's, oude telefoons prominent in beeld) kosten zwaar punten.

Wees streng: 75+ betekent "kan zo op de site". Twijfel over of het beeld wel echt bij dít onderwerp past drukt de score onder de 50.`;

// Thumbnails halen we zelf op en sturen we als base64 naar de vision-call.
// Als URL-source weigert de Anthropic API hosts met een verbiedende
// robots.txt ("Claude 400: This URL is disallowed by the website's
// robots.txt file" — o.a. de gstatic-thumbnails van Google-resultaten), en
// dan klapte de héle batch. Zelf ophalen maakt een onbereikbaar beeld een
// individueel probleem in plaats van een blokkade.
const THUMB_TIMEOUT_MS = 6000;
const THUMB_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function fetchThumb(c: ImageCandidate): Promise<ClaudeImage | null> {
  for (const url of [c.thumb_url, c.url]) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmsterdamNOW-beeldselectie)' },
      });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > THUMB_MAX_BYTES) continue;
      return { media_type: type, data: buf.toString('base64') };
    } catch { /* probeer de volgende URL */ }
  }
  return null;
}

type Score = { beeld: number; score: number; reden: string; rol: string };

// Scoort één batch kandidaten met één vision-call (de aanroeper bewaakt de
// batchgrootte en de 60s-limiet) en schrijft de scores direct naar de db.
// Elke kandidaat uit de batch is na deze functie afgehandeld: gescoord, of
// score 0 met de reden (niet laadbaar / niet beoordeelbaar) — zo loopt de
// wachtrij altijd leeg en blijft autofill nooit hangen op één rot beeld.
export async function scoreOneBatch(
  article: Pick<Article, 'title' | 'naam_locatie' | 'district'>, batch: ImageCandidate[]
): Promise<void> {
  const thumbs = await Promise.all(batch.map(fetchThumb));
  const loadable = batch.filter((_, i) => thumbs[i]);
  const images = thumbs.filter(Boolean) as ClaudeImage[];

  for (let i = 0; i < batch.length; i++) {
    if (!thumbs[i]) {
      await scoreImageCandidate(batch[i].id, 0, 'Beeld niet laadbaar voor beoordeling (thumbnail onbereikbaar).', 'geen');
    }
  }
  if (!loadable.length) return;

  let scores: Score[];
  try {
    scores = parseScores(await askClaudeJsonWithImages(STYLE_SYSTEM, buildPrompt(article, loadable), images));
  } catch (e: any) {
    // Ontbrekende API-key is een configuratiefout — die melding moet de
    // redactie letterlijk zien.
    if (String(e?.message || '').includes('niet geconfigureerd')) throw e;
    throw new Error(`Claude kon de beelden niet beoordelen (${e?.message || 'onbekende fout'}). Probeer het opnieuw.`);
  }

  for (const s of scores) {
    const cand = loadable[s.beeld - 1];
    if (cand) await scoreImageCandidate(cand.id, s.score, s.reden, s.rol);
  }
  // Wél aangeboden maar niet teruggekomen in het antwoord = niet beoordeelbaar.
  for (const cand of loadable) {
    if (!scores.some(s => loadable[s.beeld - 1]?.id === cand.id)) {
      await scoreImageCandidate(cand.id, 0, 'Niet beoordeelbaar (geen oordeel van de beoordelaar ontvangen).', 'geen');
    }
  }
}

function buildPrompt(
  article: Pick<Article, 'title' | 'naam_locatie' | 'district'>, batch: ImageCandidate[]
): string {
  const context = [
    `Artikel: "${article.title}"`,
    article.naam_locatie ? `Locatie: ${article.naam_locatie}` : '',
    article.district ? `Stadsdeel/buurt: ${article.district}` : '',
  ].filter(Boolean).join('\n');

  const meta = batch.map((c, i) =>
    `Beeld ${i + 1}: bron ${c.source}; titel "${c.title || '-'}"; gevonden met zoekterm "${c.query}"; ${c.width}×${c.height}px`
  ).join('\n');

  return `${context}

Metadata van de beelden:
${meta}

Beoordeel elk beeld op geschiktheid voor dit artikel volgens de beeldstijl. Antwoord ALLEEN met JSON:
{"scores":[{"beeld":1,"score":0-100,"reden":"één korte zin in het Nederlands","rol":"featured"|"slider"|"geen"}, …]}
Geef precies één entry per beeld, in volgorde. "rol" is je advies: "featured" alleen voor het sterkste, meest artikelspecifieke beeld.`;
}

function parseScores(data: Record<string, unknown>): Score[] {
  const arr = Array.isArray((data as any).scores) ? (data as any).scores : [];
  return arr
    .filter((s: any) => Number.isFinite(Number(s?.beeld)) && Number.isFinite(Number(s?.score)))
    .map((s: any) => ({
      beeld: Number(s.beeld),
      score: Number(s.score),
      reden: String(s.reden || '').slice(0, 300),
      rol: ['featured', 'slider'].includes(s.rol) ? s.rol : 'geen',
    }));
}
