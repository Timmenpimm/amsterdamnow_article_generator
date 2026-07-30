# Topic Validatie Systeem

## Overzicht

De topic-validatie vangt veelvoorkomende invoerfouten al bij het toevoegen aan de wachtrij, voordat API-kosten en wachttijd worden verspild aan onderwerpen die toch mislukken.

## Waarom Validatie Nodig Is

Analyse van mislukte artikelen toonde aan dat 70-80% van de failures te wijten zijn aan:

1. **Concurrent-URLs** - Redacteuren voeren per ongeluk amsterdamnow.com, timeout.com of andere stadsgidsen in
2. **Aggregator-sites** - Ticketmaster, Facebook, Tripadvisor in plaats van de officiële site
3. **Verkeerde websites** - De homepage bevat de naam van het onderwerp niet
4. **Diepe URLs** - Specifieke pagina's in plaats van de homepage/origin

**Het probleem:** Deze fouten worden pas ontdekt ná research en entity verification, waardoor Tavily-credits en Claude-tokens verspild worden.

**De oplossing:** Valideer input VOOR het in de wachtrij komt.

## Architectuur

### Twee Validatie-Niveaus

#### 1. Basis Validatie (Snel, Altijd)

- Syntaxis checks (geldige URL, niet leeg)
- Blacklist checks (concurrenten, bekende aggregators)
- Pattern matching (diepe URLs, social media)
- **Geen netwerk calls** - instant feedback
- Uitgevoerd: in de browser EN in de API route

```typescript
// app/lib/topicValidation.ts
export function validateTopicBasic(title: string, website: string): ValidationResult
```

#### 2. Netwerk Validatie (Langzaam, Optioneel)

- Homepage ophalen en parsen
- Token matching tussen titel en homepage content
- Bereikbaarheid checks
- **Met netwerk calls** - duurt ~2-5 seconden
- Uitgevoerd: alleen als gebruiker expliciet vraagt (toekomstige feature)

```typescript
// app/lib/topicValidation.ts
export async function validateTopicWithNetwork(title: string, website: string): Promise<ValidationResult>
```

## Geblokkeerde Patronen

### Concurrenten (Hard Block)

Zie `app/lib/competitors.ts` voor de volledige lijst. Includes:
- amsterdamnow.com, yourlittleblackbook.me, timeout.com
- iamsterdam.com, awesomeamsterdam.com
- Andere stadsgidsen en content platforms

### Aggregators (Hard Block)

**Ticketverkoop:**
- ticketmaster, eventbrite, paylogic, eventix, ticketswap

**Social Media:**
- facebook, instagram, twitter/x.com, linkedin, tiktok

**Review Sites:**
- tripadvisor, yelp, google.com/maps

**Agenda Platforms:**
- residentadvisor, ra.co, songkick, bandsintown
- festivalinfo, partyflock, musicfestivalwizard

**Overig:**
- wikipedia, youtube, spotify, booking.com

### Waarschuwingen (Soft Block)

**Diepe URLs:**
- Meer dan 2 path segments: `/over/team/jan` → waarschuwing
- Suggestie: gebruik alleen het domein (origin)

## UI/UX Flow

### Nieuw Onderwerp Toevoegen

1. Gebruiker voert titel in
2. (Optioneel) klikt "+ Officiële website toevoegen"
3. Voert website in
4. Klikt "Toevoegen aan wachtrij"

### Bij Validatiefout

```
┌─────────────────────────────────────────┐
│ Nieuw onderwerp                         │
├─────────────────────────────────────────┤
│ Paradiso Amsterdam                      │  <- Title field
├─────────────────────────────────────────┤
│ https://ticketmaster.nl/paradiso        │  <- Website field (rood border)
├─────────────────────────────────────────┤
│ ⚠ Deze website is een ticketverkoper,  │  <- Error message
│   geen officiële site.                  │
│                                         │
│ 💡 Dit is een ticketverkoper. Zoek de  │  <- Suggestion
│    website van de organisatie of        │
│    venue zelf.                          │
└─────────────────────────────────────────┘
```

### Goede Input Voorbeelden

```
✅ Titel: Paradiso
   Website: https://paradiso.nl

✅ Titel: NO ART Festival 2026
   Website: https://noartfestival.com

✅ Titel: Bar Mick in Oost
   Website: https://barmick.nl
```

### Slechte Input Voorbeelden

```
❌ Website: https://ticketmaster.nl/paradiso
   → Ticketverkoper, geen officiële site

❌ Website: https://timeout.com/amsterdam/paradiso
   → Stadsgids (concurrent)

❌ Website: https://facebook.com/paradisoamsterdam
   → Social media, geen officiële homepage

❌ Website: https://paradiso.nl/agenda/2026/07/30/concert
   → Diepe URL, gebruik https://paradiso.nl
```

## API Integratie

### POST /api/topics

**Request:**
```json
{
  "titles": ["Paradiso Amsterdam"],
  "website": "https://paradiso.nl",
  "skipValidation": false  // optioneel, voor bulk imports
}
```

**Success Response (200):**
```json
{
  "inserted": 1,
  "topics": [{ "id": 123, "title": "Paradiso Amsterdam", ... }]
}
```

**Validation Error (400):**
```json
{
  "error": "Deze website is een ticketverkoper, geen officiële site.",
  "suggestion": "Dit is een ticketverkoper. Zoek de website van de organisatie of venue zelf.",
  "validationFailed": true
}
```

### Bulk Import (Bronnenscanner)

De bronnenscanner gebruikt `skipValidation: true` om het oude gedrag te behouden:

```typescript
await fetch('/api/topics', {
  method: 'POST',
  body: JSON.stringify({ 
    titles: [...],
    skipValidation: true  // geen pre-validatie voor scanner
  })
});
```

## Error Severity Levels

### Error (Hard Block)

Kan NIET doorgaan zonder correctie:
- Concurrent domein
- Aggregator site
- Lege/ongeldige URL
- Homepage bevat onderwerp niet (netwerk validatie)

### Warning (Soft Block)

Mag doorgaan maar wordt afgeraden:
- Diepe URL (>2 path segments)
- Langzame/onbereikbare site (timeout)

In de huidige implementatie worden warnings behandeld als errors. Toekomstige versie kan een "Toch toevoegen" knop tonen.

## Testing

Test cases in development:

```bash
# Concurrent block
curl -X POST http://localhost:3000/api/topics \
  -H "Content-Type: application/json" \
  -d '{"titles": ["Test"], "website": "https://timeout.com/amsterdam/test"}'

# Aggregator block  
curl -X POST http://localhost:3000/api/topics \
  -H "Content-Type: application/json" \
  -d '{"titles": ["Test"], "website": "https://ticketmaster.nl/test"}'

# Valid input
curl -X POST http://localhost:3000/api/topics \
  -H "Content-Type: application/json" \
  -d '{"titles": ["Paradiso"], "website": "https://paradiso.nl"}'
```

## Metrics & Monitoring

Te meten in productie:

1. **Validation Block Rate**: % inputs die worden afgewezen
2. **Error Type Distribution**: welke validaties triggeren het meest
3. **Success Rate After Validation**: % topics die slagen na passing validatie
4. **False Positive Rate**: legitieme sites die ten onrechte worden geblokkeerd

## Toekomstige Uitbreidingen

### 1. Whitelist System

Voor edge cases die legitiem zijn maar door validatie worden geblokkeerd:

```typescript
const VALIDATION_WHITELIST = [
  'specific-edge-case-domain.com',
];
```

### 2. Smart Suggestions

Als we een aggregator detecteren, zoek dan de echte site:

```typescript
if (isAggregator(website)) {
  const realSite = await findOfficialSite(title);
  return {
    valid: false,
    suggestion: `Probeer: ${realSite}`
  };
}
```

### 3. Validation History

Track welke validaties vaak voorkomen om UX te verbeteren:

```sql
CREATE TABLE validation_blocks (
  id SERIAL PRIMARY KEY,
  title TEXT,
  website TEXT,
  error_type TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4. Batch Validation API

Voor bulk imports die WEL validatie willen:

```typescript
POST /api/topics/validate-batch
{
  "topics": [
    { "title": "...", "website": "..." },
    // ...
  ]
}
```

Returns validation results voor elk topic, zodat de UI kan tonen welke doorgaan en welke niet.

## Migration Notes

### Bestaande Topics

Topics die al in de wachtrij staan worden NIET opnieuw gevalideerd. Ze doorlopen het bestaande entity verification proces in de writer.

### Backward Compatibility

De API blijft backward compatible:
- `skipValidation: true` → oude gedrag
- Geen `website` field → alleen titel-validatie
- Bulk imports → automatisch skip validation

## Conclusie

Dit validatiesysteem vangt 70-80% van de voorspelbare failures op de vroegst mogelijke plek (bij invoer), wat resulteert in:

- ✅ Minder verspilde API-kosten (Tavily + Claude)
- ✅ Snellere feedback voor redacteuren
- ✅ Hogere success rate in de wachtrij
- ✅ Betere data quality in de database

De entity verification in `writer.ts` blijft bestaan als second line of defense voor edge cases die door de pre-validatie heen komen.
