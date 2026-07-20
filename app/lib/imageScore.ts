import { askClaudeJsonWithImages } from './claude';
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

type Score = { beeld: number; score: number; reden: string; rol: string };

// Scoort één batch kandidaten met één vision-call (de aanroeper bewaakt de
// batchgrootte en de 60s-limiet) en schrijft de scores direct naar de db.
// Wél aangeboden maar niet teruggekomen in het antwoord = niet beoordeelbaar;
// niet-aangeboden beelden (afgeknepen batch) blijven 'new' voor de volgende tik.
export async function scoreOneBatch(
  article: Pick<Article, 'title' | 'naam_locatie' | 'district'>, batch: ImageCandidate[]
): Promise<void> {
  const { scores, attempted } = await scoreBatch(article.title, article.naam_locatie, article.district, batch);
  for (const s of scores) {
    const cand = batch[s.beeld - 1];
    if (cand) await scoreImageCandidate(cand.id, s.score, s.reden, s.rol);
  }
  for (const cand of batch.slice(0, attempted)) {
    if (!scores.some(s => batch[s.beeld - 1]?.id === cand.id)) {
      await scoreImageCandidate(cand.id, 0, 'Niet beoordeelbaar (beeld niet leesbaar voor de beoordelaar).', 'geen');
    }
  }
}

async function scoreBatch(
  title: string, locatie: string, district: string, batch: ImageCandidate[]
): Promise<{ scores: Score[]; attempted: number }> {
  const context = [
    `Artikel: "${title}"`,
    locatie ? `Locatie: ${locatie}` : '',
    district ? `Stadsdeel/buurt: ${district}` : '',
  ].filter(Boolean).join('\n');

  const meta = batch.map((c, i) =>
    `Beeld ${i + 1}: bron ${c.source}; titel "${c.title || '-'}"; gevonden met zoekterm "${c.query}"; ${c.width}×${c.height}px`
  ).join('\n');

  const prompt = `${context}

Metadata van de beelden:
${meta}

Beoordeel elk beeld op geschiktheid voor dit artikel volgens de beeldstijl. Antwoord ALLEEN met JSON:
{"scores":[{"beeld":1,"score":0-100,"reden":"één korte zin in het Nederlands","rol":"featured"|"slider"|"geen"}, …]}
Geef precies één entry per beeld, in volgorde. "rol" is je advies: "featured" alleen voor het sterkste, meest artikelspecifieke beeld.`;

  const parse = (data: Record<string, unknown>): Score[] => {
    const arr = Array.isArray((data as any).scores) ? (data as any).scores : [];
    return arr
      .filter((s: any) => Number.isFinite(Number(s?.beeld)) && Number.isFinite(Number(s?.score)))
      .map((s: any) => ({
        beeld: Number(s.beeld),
        score: Number(s.score),
        reden: String(s.reden || '').slice(0, 300),
        rol: ['featured', 'slider'].includes(s.rol) ? s.rol : 'geen',
      }));
  };

  try {
    const scores = parse(await askClaudeJsonWithImages(STYLE_SYSTEM, prompt, batch.map(c => c.thumb_url)));
    return { scores, attempted: batch.length };
  } catch (e: any) {
    // Ontbrekende API-key is een configuratiefout — die melding moet de
    // redactie letterlijk zien, niet een thumbnail-smoes.
    if (String(e?.message || '').includes('niet geconfigureerd')) throw e;
    // Eén onbereikbare thumbnail laat de hele vision-call falen; een kleinere
    // batch redt de request meestal. De rest blijft 'new' voor de volgende tik.
    if (batch.length <= 6) {
      throw new Error(`Claude kon de beelden niet beoordelen (${e?.message || 'onbekende fout'}). Probeer het opnieuw.`);
    }
    return scoreBatch(title, locatie, district, batch.slice(0, 6));
  }
}
