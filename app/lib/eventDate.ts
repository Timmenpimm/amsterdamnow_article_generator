// Gedeelde "is dit event al voorbij?"-logica.
//
// Deze check hoorde op drie plekken in de pipeline te staan, maar stond er
// maar op één: de bronnenscanner. Gevolg (artikel 86418, Still Processing in
// Nxt Museum): een handmatig ingevoerd topic over een expositie die op
// 29-06-2026 sloot ging op 20-07-2026 gewoon de wachtrij door, werd
// geschreven als "loopt nog" en kwam als publicabele draft op het bord.
// Handmatige invoer sloeg de scanner-check over, en research noch publisher
// keek ooit naar de einddatum.
//
// Daarom staat de logica nu hier, één keer, en gebruiken alle drie de poorten
// 'm:
//   1. scanner.ts   — scan-items met een verlopen einddatum komen de
//                     wachtrij niet in.
//   2. writer.ts    — de research-fase breekt af zodra de bronnen een
//                     verlopen einddatum geven; er wordt geen draft
//                     aangemaakt (geldt óók voor handmatige topics).
//   3. publisher.ts — een draft met een verlopen event wordt nooit
//                     automatisch gepubliceerd.

// JJJJ-MM-DD in Europe/Amsterdam. De hele pipeline hanteert dezelfde
// "vandaag" als de kalenderdag van de redactie, ongeacht de serverzone.
export function amsterdamToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(now);
}

// Strikt JJJJ-MM-DD of ''. Alles wat niet exact dat formaat heeft (null,
// "doorlopend", een bereik, een Date) → '' en telt dus als "geen datum".
export function isoOrEmpty(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// De datum waarop een event "af" is: de einddatum, of bij ontbreken de
// startdatum (eendaags event). '' als geen van beide bruikbaar is.
export function eventEndReference(start: unknown, eind: unknown): string {
  return isoOrEmpty(eind) || isoOrEmpty(start);
}

// Voorbij = de referentiedatum ligt vóór vandaag. Een event dat vandaag
// afloopt telt dus nog als lopend.
//
// Bewust fail-open: zonder parsebare datum is dit géén verlopen event. Niet
// elk onderwerp is een event (vaste zaken, openingen, nieuws), en die mogen
// niet geblokkeerd worden door een ontbrekende datum.
export function isPastEvent(start: unknown, eind: unknown, todayISO: string): boolean {
  const ref = eventEndReference(start, eind);
  return ref !== '' && ref < todayISO;
}
