import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import { getArticle } from '@/lib/wp';
import {
  engineConfigured, engineErrorJson, notConfiguredJson, toContent, toMeta,
  type EngineCarousel,
} from '@/lib/carouselEngine';
import { isNowTemplate } from '@/lib/carousel';
import type { CarouselSlide } from '@/lib/carousel';
import { getListStructure } from '@/lib/db';
import { parseListItemImages, type ListItemImage } from '@/lib/listHtml';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Zelfde cap als imageUrls hieronder: de engine valideert allebei de lijsten op
// max 20 en wijst het HELE generatieverzoek af zodra er één te veel in zit.
const MAX_ITEM_IMAGES = 20;

// Welke foto hoort bij welke zaak? De engine deelde de beelden op volgorde uit
// over de itemslides, maar het model kiest zelf de sterkste 2 tot 8 items uit
// een artikel dat er 15 tot 25 heeft. Koos het item 3, 7 en 12, dan stond er een
// foto van de verkeerde zaak bij. Deze lijst laat de engine matchen op naam.
//
// Bron van waarheid, in deze volgorde:
//   1. de opgeslagen lijststructuur — die heeft per item naam + itemfoto, exact
//      wat de tool zelf naar WordPress geschreven heeft;
//   2. de gepubliceerde HTML. Die rij bestaat alleen voor lijstartikelen die de
//      tool zelf schreef; oude en handmatige artikelen hebben hem niet.
// Levert geen van beide iets op, dan gaat er niets mee en valt de engine terug
// op de volgorde van imageUrls — precies het gedrag van vóór deze koppeling.
async function itemImagesFor(postId: number, contentHtml: string): Promise<ListItemImage[]> {
  let pairs: ListItemImage[] = [];

  try {
    const structure = await getListStructure(postId);
    pairs = (structure?.items || [])
      .map(item => ({ naam: (item.naam || '').trim(), imageUrl: item.media?.url || '' }))
      .filter(p => p.naam && p.imageUrl);
  } catch {
    // Databasefout mag het genereren niet blokkeren: door naar de HTML-parse.
  }

  if (!pairs.length) pairs = parseListItemImages(contentHtml);

  // Relatieve paden eruit (de engine valideert op z.string().url()) en per naam
  // maar één foto, zodat twee gelijknamige items de match niet dubbel bezetten.
  const seen = new Set<string>();
  const out: ListItemImage[] = [];
  for (const pair of pairs) {
    if (out.length >= MAX_ITEM_IMAGES) break;
    if (!/^https?:\/\//i.test(pair.imageUrl)) continue;
    if (seen.has(pair.naam)) continue;
    seen.add(pair.naam);
    out.push(pair);
  }
  return out;
}

// POST /api/carousel/[articleId]/generate — laadt het artikel server-side uit
// WordPress en laat de engine er een carousel van maken (POST /api/generate).
export async function POST(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const id = Number(articleId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Ongeldig artikel-id.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  // Template gaat ongewijzigd door naar de engine: zowel de satori-ids
  // ('modern-news'/…) als de Amsterdam NOW-ids ('now:<family>'). De engine is
  // de enige die weet welke ids bestaan; hier niet valideren.
  const body = await req.json().catch(() => null);
  const template = typeof body?.template === 'string' ? body.template : undefined;

  const article = await getArticle(id);
  if (!article) {
    return NextResponse.json({ error: 'Artikel niet gevonden.' }, { status: 404 });
  }

  const itemImages = await itemImagesFor(id, article.contentHtml);

  const payload = {
    article: {
      wordpressId: article.id,
      title: article.title,
      contentHtml: article.contentHtml,
      excerpt: article.intro || article.subregel || undefined,
      imageUrl: article.featured?.url || undefined,
      // NOW-templates gebruiken het eerste beeld als cover en verdelen de
      // rest over detail-/itemslides. Zonder deze lijst kreeg de engine alleen
      // de featured-foto en viel iedere fotoslide daarop terug.
      //
      // Volgorde is functioneel, geen smaak: de featured-foto moet vooraan
      // staan zodat de engine hem als cover kiest, en de contentbeelden komen
      // dáárna maar vóór de slider. De engine haalt de cover uit de lijst en
      // pakt per lijst-item het n-de resterende beeld; alleen zo landt
      // itemfoto N op itemslide N. Stonden de sliderbeelden ertussen, dan
      // schoof elk itembeeld op. Itemfoto's zitten niet in slider/inline maar
      // los in de content-HTML (lib/listHtml.ts), vandaar contentImages.
      //
      // De cap is er omdat de engine imageUrls valideert als
      // z.array(z.string().url()).max(20): één relatief pad of het 21e beeld
      // laat hem het HELE generatieverzoek afwijzen op "Invalid input". Een
      // lijstje met 20+ itemfoto's is dus geen randgeval maar de norm.
      imageUrls: [article.featured, ...(article.contentImages || []), ...(article.slider || []), article.inline]
        .map(m => m?.url)
        .filter((url, i, urls): url is string =>
          Boolean(url) && /^https?:\/\//i.test(url!) && urls.indexOf(url) === i)
        .slice(0, 20),
      // Naast imageUrls, niet in plaats daarvan: hiermee zet de engine de foto
      // van een zaak op de slide óver die zaak, in plaats van op volgorde. Leeg
      // voor niet-lijstartikelen; dan blijft alles bij het oude (zie
      // itemImagesFor).
      ...(itemImages.length ? { itemImages } : {}),
      categories: [article.category].filter(Boolean),
      tags: article.tags,
    },
    template,
  };

  try {
    const res = await engineFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
      // Genereren kan lang duren (Claude-call + renderen aan engine-kant).
      signal: AbortSignal.timeout(55000),
    });
    const eng = await res.json().catch(() => null);
    const c: EngineCarousel | undefined = eng?.carousel;
    if (!c?.id) {
      return NextResponse.json({ error: 'Onverwacht antwoord van de socials-engine bij het genereren.' }, { status: 502 });
    }

    // De engine kent alleen imagePrompts; de artikelbeelden zelf leven hier.
    // Zelfde toewijzing als de oude mock: hero/cta krijgen het uitgelichte
    // beeld, image-slides doorlopen de sliderbeelden. Daarna terugschrijven
    // zodat de engine dezelfde beelden gebruikt bij render/publicatie.
    //
    // Alléén voor satori-carousels: NOW-slides hebben geen layout/imageUrl maar
    // slideType + values, en hun beeld-tokens zitten in het manifest. Die laten
    // we ongemoeid — nooit in de satori-vorm dwingen.
    const isNow = isNowTemplate(template) || isNowTemplate(c.template);
    const pool = [article.featured, ...(article.slider || [])]
      .map(m => m?.url)
      .filter((u, i, arr): u is string => Boolean(u) && arr.indexOf(u) === i);
    if (!isNow && pool.length && Array.isArray(c.slides)) {
      let next = 1;
      c.slides = (c.slides as CarouselSlide[]).map(s => {
        if (s.imageUrl) return s;
        if (s.layout === 'hero' || s.layout === 'cta') return { ...s, imageUrl: pool[0] };
        if (s.layout === 'image') {
          const url = pool[next % pool.length] ?? pool[0];
          next += 1;
          return { ...s, imageUrl: url };
        }
        return s;
      });
      try {
        await engineFetch(`/api/carousels/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ slides: c.slides }),
        });
      } catch {
        // Verrijking is best-effort: de content met beelden gaat sowieso terug
        // naar de client; de eerstvolgende autosave schrijft ze alsnog weg.
      }
    }

    return NextResponse.json(
      { carouselId: c.id, meta: toMeta(id, c), content: toContent(c, article.title) },
      { status: 201 }
    );
  } catch (err) {
    return engineErrorJson(err);
  }
}
