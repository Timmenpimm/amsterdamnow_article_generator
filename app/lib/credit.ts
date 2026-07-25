// Bronvermelding (ACF-veld `fotograaf`) opbouwen en schoonhouden.
//
// Het veld is opgebouwd als `auteur · bron · licentie`. Drie van de vier
// beeldproviders leveren een échte licentie (Openverse "CC-BY 4.0", Commons
// "CC BY 3.0", Pexels "Pexels-licentie") — die hoort erbij te blijven, want
// bij CC-BY is naamsvermelding een voorwaarde van de licentie zelf.
//
// De Google-tak levert géén echte licentie. `tbs=il:cl` is Googles eigen
// rechtenfilter en de licentie-info komt uit paginamarkup: indicatief, niet
// vastgesteld. Die claim stond tot 25-07-2026 als "Creative Commons
// (Google-rechtenfilter — check de bronpagina)" in het WordPress-veld van elk
// artikel dat via Google beeld kreeg — inclusief beelden van Tripadvisor,
// Uber Eats en TheFork, die zeker niet CC-gelicentieerd zijn. Een audit van de
// kolom "Klaar voor publicatie" vond de string in 30 van de 31 artikelen.
// WordPress is geen plek voor een onbevestigde licentieclaim, dus die staart
// gaat er hier af; auteur en bron blijven staan.
export const GOOGLE_LICENSE_NOTE = 'Creative Commons (Google-rechtenfilter — check de bronpagina)';

// Alles wat naar het Google-rechtenfilter verwijst, ook als de tekst ooit iets
// anders geformuleerd was (oudere posts, handmatig geplakte varianten).
const UNVERIFIED_LICENSE = /google-?rechtenfilter/i;

const SEP = ' · ';

// Splitst op de scheidingstekens en gooit de segmenten weg die een
// onbevestigde licentieclaim zijn. Laat echte licenties ongemoeid.
export function cleanCredit(credit: string): string {
  return (credit || '')
    .split(SEP)
    .map(part => part.trim())
    .filter(part => part && !UNVERIFIED_LICENSE.test(part))
    .join(SEP);
}

// True als er iets te schonen valt — de backfill gebruikt dit om posts die al
// goed staan over te slaan (scheelt WordPress-schrijfacties).
export function needsCleaning(credit: string): boolean {
  return cleanCredit(credit) !== (credit || '').trim();
}

// Bouwt de bronvermelding uit de kandidaat-metadata. Enige plek waar het
// formaat `auteur · bron · licentie` wordt vastgelegd.
export function buildCredit(parts: { author?: string; source?: string; license?: string }): string {
  return cleanCredit([parts.author, parts.source, parts.license].filter(Boolean).join(SEP));
}
