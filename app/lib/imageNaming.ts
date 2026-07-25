import type { Article } from './types';
import type { ImageNameContext } from './mediaName';

// Brug tussen het Article-model en de beeldnaamconventie in lib/mediaName.ts.
// Die module kent Article bewust niet (hij is puur en los te testen), dus de
// vertaalslag staat hier — één keer, zodat de vier upload-paden (media,
// item-media, autofill, backfill-orientation) niet uit elkaar kunnen lopen.

/** Naamcontext voor de AmsterdamNOW-beeldconventie: bestandsnaam == media-slug == media-titel == alt. */
export function nameContext(a: Article): ImageNameContext {
  return {
    naamLocatie: a.naam_locatie,
    title: a.title,
    slug: a.slug,
    category: a.category,
    district: a.district,
    stad: a.stad,
  };
}

/**
 * Startpunt voor de `_n`-teller van het artikelbrede basiswoord.
 *
 * Tellen op unieke media-id's, niet op slots: een featured beeld staat vaak óók
 * in de slider, en op slots tellen zou dat dubbel rekenen en een gat in de
 * nummering slaan.
 *
 * Itemfoto's van lijstartikelen tellen hier bewust NIET mee — anders dan in
 * imageCount() (lib/types.ts), dat een gebruikersteller is en geen
 * naamgevingsteller. Een itemfoto draagt een ánder basiswoord (de itemnaam, via
 * listItemNameContext) en heeft zijn eigen reeks. Zou je ze meetellen, dan
 * begint de artikelreeks bij een lijst met vijf itemfoto's ineens op _6 terwijl
 * er van dát basiswoord nog geen enkel beeld bestaat.
 */
export function attachedImageCount(a: Article): number {
  const ids = new Set<number>();
  if (a.featured) ids.add(a.featured.id);
  for (const m of a.slider) ids.add(m.id);
  if (a.inline) ids.add(a.inline.id);
  return ids.size;
}
