// Pre-submission validatie om veelvoorkomende invoerfouten te vangen vóórdat
// het onderwerp in de wachtrij komt. Bespaart API-kosten en wachttijd door
// probleemtopics direct af te keuren met concrete feedback voor de redactie.
//
// GEEN 'use client' hier: dit is een puur hulpbestand zonder React/DOM, dat
// zowel door client-componenten (Pipeline, TopicForm) als door server-routes
// (topics POST/PATCH) wordt geïmporteerd. Met de directive maakt Next er in
// server-context een client-reference van en faalt elke aanroep met een 500 —
// precies wat de bord-herstelactie "Instellen + retry" brak.

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string; suggestion?: string; severity: 'error' | 'warning' };

// Domeinpatronen die wijzen op ticketverkoop, agenda's of reviews — geen
// officiële sites van een zaak. Uitgebreid t.o.v. AGGREGATOR_HOSTS in
// tavily.ts met veelvoorkomende Nederlandse platformen.
const COMMON_AGGREGATOR_PATTERNS = [
  'ticketmaster', 'eventbrite', 'facebook', 'instagram', 'tripadvisor',
  'timeout', 'iamsterdam', 'paylogic', 'eventix', 'ticketswap',
  'residentadvisor', 'ra.co', 'songkick', 'bandsintown', 'booking.com',
  'google.com/maps', 'yelp', 'wikipedia', 'reddit', 'linkedin',
];

// Concurrent detection - inline versie om import van competitors.ts te vermijden
const COMPETITOR_HOSTS = [
  'amsterdamnow', 'yourlittleblackbook', 'ylbb', 'timeout', 'awesomeamsterdam',
  'iamsterdam', 'amsterdam.info', 'sterdam.com', 'thingstodo.amsterdam',
];

function competitorInHost(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return COMPETITOR_HOSTS.some(c => host.includes(c));
  } catch {
    return false;
  }
}

// Aggregator check - inline versie om import van tavily.ts te vermijden
function isAggregatorHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const allPatterns = [...COMMON_AGGREGATOR_PATTERNS, 'youtube', 'spotify', 'google', 'tiktok', 'x.com', 'twitter'];
    return allPatterns.some(a => host.includes(a));
  } catch {
    return true; // Ongeldige URL behandelen als aggregator
  }
}

// URLs die vaak per ongeluk als "website" worden ingevoerd omdat ze hoog
// in de zoekresultaten staan, maar geen officiële site zijn.
function looksLikeAggregator(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return COMMON_AGGREGATOR_PATTERNS.some(p => host.includes(p));
  } catch {
    return false;
  }
}

// Basisvalidatie die geen netwerk-calls vereist: syntaxis, blacklists, etc.
export function validateTopicBasic(title: string, website: string): ValidationResult {
  // 1. Titel mag niet leeg zijn
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    return { 
      valid: false, 
      reason: 'De titel mag niet leeg zijn.',
      severity: 'error'
    };
  }

  // 2. Titel mag niet te kort zijn (vaak een typo of incomplete invoer)
  if (cleanTitle.length < 3) {
    return {
      valid: false,
      reason: 'De titel is te kort. Gebruik de volledige naam van de zaak of het evenement.',
      severity: 'error'
    };
  }

  // 3. Website mag leeg zijn (optioneel gemaakt)
  const cleanWebsite = website.trim();
  if (cleanWebsite) {
    // Alleen valideren als website is ingevuld
    let url: URL;
    try {
      url = new URL(cleanWebsite);
    } catch {
      return {
        valid: false,
        reason: 'De website is geen geldige URL.',
        suggestion: 'Gebruik het volledige formaat: https://voorbeeld.nl',
        severity: 'error'
      };
    }

    // 4. Als website is ingevuld, valideer deze
    // 4a. Website moet http of https zijn
    if (!['http:', 'https:'].includes(url.protocol)) {
      return {
        valid: false,
        reason: 'De website moet beginnen met http:// of https://',
        severity: 'error'
      };
    }

    // 4b. Concurrent-domein blokkeren
    if (competitorInHost(cleanWebsite)) {
      return {
        valid: false,
        reason: 'Dit is een concurrent. We schrijven niet over onze eigen artikelen.',
        suggestion: 'Gebruik de officiële website van de onderliggende zaak of het evenement.',
        severity: 'error'
      };
    }

    // 4c. Veelvoorkomende aggregators blokkeren
    if (looksLikeAggregator(cleanWebsite)) {
      const host = url.hostname.toLowerCase();
      let specificSuggestion = 'Zoek naar de officiële website van de zaak of het evenement.';

      if (host.includes('facebook') || host.includes('instagram')) {
        specificSuggestion = 'Gebruik de officiële website, niet de social media pagina.';
      } else if (host.includes('ticketmaster') || host.includes('eventbrite') || host.includes('paylogic')) {
        specificSuggestion = 'Dit is een ticketverkoper. Zoek de website van de organisatie of venue zelf.';
      } else if (host.includes('tripadvisor') || host.includes('yelp')) {
        specificSuggestion = 'Dit is een review-site. Gebruik de officiële website van de zaak.';
      } else if (host.includes('timeout') || host.includes('iamsterdam')) {
        specificSuggestion = 'Dit is een stadsgids of agenda. Zoek de eigen website van de zaak.';
      }

      return {
        valid: false,
        reason: `Deze website is een ${getAggregatorType(host)}, geen officiële site.`,
        suggestion: specificSuggestion,
        severity: 'error'
      };
    }

    // 4d. Aggregator-check
    if (isAggregatorHost(cleanWebsite)) {
      return {
        valid: false,
        reason: 'Deze website is een agenda, ticketsite of social media platform.',
        suggestion: 'Gebruik de officiële homepage van de zaak of het evenement.',
        severity: 'error'
      };
    }

    // 4e. Waarschuw bij diepe URLs
    if (url.pathname.length > 1 && url.pathname !== '/') {
      const pathDepth = url.pathname.split('/').filter(p => p).length;
      if (pathDepth > 2) {
        return {
          valid: false,
          reason: 'Deze URL wijst naar een specifieke pagina, niet de homepage.',
          suggestion: `Gebruik alleen het domein: ${url.origin}`,
          severity: 'warning'
        };
      }
    }
  }

  return { valid: true };
}

function getAggregatorType(hostname: string): string {
  if (hostname.includes('facebook') || hostname.includes('instagram')) return 'social media platform';
  if (hostname.includes('ticket')) return 'ticketverkoper';
  if (hostname.includes('tripadvisor') || hostname.includes('yelp')) return 'review-site';
  if (hostname.includes('timeout') || hostname.includes('iamsterdam')) return 'stadsgids';
  if (hostname.includes('eventbrite')) return 'event-platform';
  return 'aggregator';
}

// Netwerk-validatie: controleert of de homepage bereikbaar is en de
// onderwerptitel bevat. Deze check is langzamer en wordt alleen uitgevoerd
// als de gebruiker expliciet op "Valideer" klikt of als de basis-validatie
// slaagt en de gebruiker probeert op te slaan.
export async function validateTopicWithNetwork(
  title: string, 
  website: string
): Promise<ValidationResult> {
  // Eerst basisvalidatie
  const basicResult = validateTopicBasic(title, website);
  if (!basicResult.valid) return basicResult;

  const cleanTitle = title.trim().toLowerCase();
  const cleanWebsite = website.trim();

  try {
    // Homepage ophalen met timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(cleanWebsite, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmsterdamNOW-validator)' },
      redirect: 'follow',
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        valid: false,
        reason: `De website is niet bereikbaar (HTTP ${response.status}).`,
        suggestion: 'Controleer of de URL correct is en de site online is.',
        severity: 'error'
      };
    }

    const html = await response.text();
    const text = stripHtml(html).toLowerCase();

    if (!text) {
      return {
        valid: false,
        reason: 'De website bevat geen leesbare inhoud.',
        suggestion: 'Controleer of dit de juiste URL is.',
        severity: 'error'
      };
    }

    // Check of de titel (of belangrijke tokens ervan) op de homepage staat
    const titleTokens = cleanTitle
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4);

    const matchedTokens = titleTokens.filter(token => text.includes(token));
    const matchRatio = titleTokens.length > 0 ? matchedTokens.length / titleTokens.length : 0;

    if (matchRatio < 0.5) {
      return {
        valid: false,
        reason: 'De naam van het onderwerp staat niet op deze homepage.',
        suggestion: 'Controleer of dit wel de officiële website is van deze specifieke zaak of dit evenement.',
        severity: 'error'
      };
    }

    // Success
    return { valid: true };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    if (message.includes('aborted') || message.includes('timeout')) {
      return {
        valid: false,
        reason: 'De website reageert te langzaam.',
        suggestion: 'Probeer het later opnieuw of controleer de URL.',
        severity: 'warning'
      };
    }

    return {
      valid: false,
      reason: 'Kon de website niet bereiken.',
      suggestion: 'Controleer of de URL correct is.',
      severity: 'warning'
    };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper voor de UI: geeft aan of een waarschuwing fataal is
export function isFatalValidation(result: ValidationResult): boolean {
  return !result.valid && result.severity === 'error';
}

// Helper voor de UI: formatteert validatie-feedback voor display
export function formatValidationMessage(result: ValidationResult): string {
  if (result.valid) return '';
  
  let message = result.reason;
  if (result.suggestion) {
    message += `\n\n💡 ${result.suggestion}`;
  }
  return message;
}
