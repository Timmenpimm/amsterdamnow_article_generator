import {
  activeConstraints, activeListTopic, activePrompt, claimNextListTopic, completeTopic, failTopic,
  getTopic, saveTopicProgress, saveListStructure,
} from './db';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import {
  LIST_SELECT_SCHEMA, LIST_VERIFY_SCHEMA, LIST_COMPOSE_FIRST_SCHEMA,
  LIST_COMPOSE_ITEMS_SCHEMA, SEO_SCHEMA,
} from './schemas';
import { researchWithTavily } from './tavily';
import { createDraft, findArticleLink, taxonomyChoices } from './wp';
import { assembleListHtml } from './listHtml';
import { quoteSourceAllowed, validateListArticle, type GeneratedListArticle } from './validation';
import type { ComposedList, ListArticleStructure, ListConstraints, ListItemState, ListState, Topic } from './types';

const VERIFY_PER_TICK = 2; // items per aanroep, zodat elke stap binnen de serverless-limiet blijft
// Tekens per Tavily-bron die naar de verificatie-call gaan. Tavily levert tot
// 5 bronnen; op 8000 tekens elk was dit veruit de grootste token-post van de
// pijplijn. Adres/openingstijden staan doorgaans vooraan in de geëxtraheerde
// content, dus 4000 tekens per bron houdt de verificatie betrouwbaar terwijl
// het de invoer ongeveer halveert.
const VERIFY_SOURCE_CHARS = 4000;

function state(topic: Topic): ListState {
  if (!topic.list_state) throw new Error('Lijst-topic heeft geen state.');
  return JSON.parse(topic.list_state) as ListState;
}

function recount(s: ListState) {
  s.verified = s.items.filter(i => i.status === 'verified').length;
  s.rejected = s.items.filter(i => i.status === 'rejected').length;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function weekendContext(weekendgids: boolean): string {
  if (!weekendgids) return '';
  const now = new Date();
  const saturday = new Date(now);
  saturday.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7));
  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);
  const fmt = (d: Date) => d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `\nDit is een WEEKENDGIDS-item. Vandaag is ${fmt(now)}. Het doelweekend is ${fmt(saturday)} en ${fmt(sunday)}. Pas de weekendgids-regels toe.`;
}

export interface ListStepResult {
  topic: Topic;
  phase: string;
  done: boolean;          // true zodra de draft er staat of de run wacht op review
  progress: string;       // korte statusregel voor het bord
  article?: { id: number; title: string };
}

// Eén stap van de lijstpipeline. De frontend blijft aanroepen zolang
// done=false; bij status 'review' pauzeert de machine tot de redacteur
// de items heeft goedgekeurd.
export async function processListStep(topicId?: number): Promise<ListStepResult | null> {
  const topic = topicId ? await getTopic(topicId) : (await activeListTopic()) || (await claimNextListTopic());
  if (!topic || topic.type !== 'lijst') return null;
  try {
    switch (topic.phase) {
      case 'select': return await stepSelect(topic);
      case 'verify': return await stepVerify(topic);
      case 'compose': return await stepCompose(topic);
      case 'finalize': return await stepFinalize(topic);
      case 'review':
        return { topic, phase: 'review', done: true, progress: 'Wacht op itemcontrole door de redactie' };
      default:
        throw new Error(`Onbekende fase: ${topic.phase}`);
    }
  } catch (error: any) {
    await failTopic(topic.id, error.message || 'Onbekende fout', `lijstfase: ${topic.phase}`);
    throw error;
  }
}

async function stepSelect(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const prompt = await activePrompt('lijst-selectie');
  const sources = await researchWithTavily(topic.title);
  const result = await askClaudeJson(
    prompt.content,
    `Thema van het lijstartikel: ${topic.title}${weekendContext(s.weekendgids)}\n\nTavily-bronnen:\n${sources.map((x, i) => `\n[${i + 1}] ${x.title}\n${x.url}\n${x.content.slice(0, 6000)}`).join('\n')}`,
    false, FAST_WRITE_MODEL, 6000, LIST_SELECT_SCHEMA,
  );
  const kandidaten = Array.isArray(result.kandidaten) ? result.kandidaten : [];
  const items: ListItemState[] = kandidaten
    .map((k: any) => ({ naam: str(k.naam), status: 'pending' as const }))
    .filter((k: ListItemState) => k.naam);
  if (items.length < 3) throw new Error('De selectiefase leverde minder dan 3 kandidaat-items op.');
  s.items = items;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'verify', state: s });
  return {
    topic, phase: 'verify', done: false,
    progress: `${items.length} kandidaten gevonden · verificatie start`,
  };
}

async function stepVerify(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const constraints = await activeConstraints('lijst');
  const pending = s.items.filter(i => i.status === 'pending').slice(0, VERIFY_PER_TICK);
  if (!pending.length) {
    await saveTopicProgress(topic.id, { status: 'review', phase: 'review', state: s });
    return { topic, phase: 'review', done: true, progress: `Verificatie klaar: ${s.verified} opgenomen, ${s.rejected} afgevallen · wacht op controle` };
  }
  const prompt = await activePrompt('lijst-research');
  for (const item of pending) {
    let sources;
    try {
      sources = await researchWithTavily(`${item.naam}`);
    } catch (error: any) {
      // Configuratiefouten (ontbrekende API-key) horen de run te laten falen;
      // alleen "niets gevonden" is een geldige reden om een item af te keuren.
      if (String(error?.message || '').includes('niet geconfigureerd')) throw error;
      item.status = 'rejected';
      item.reden = 'Geen bruikbare bronnen gevonden';
      continue;
    }
    // Grootste kostenpost van de hele pipeline (±12 items × ~6k input-tokens):
    // verificatie is extractiewerk ("staat het adres in deze bronnen"),
    // Sonnet 5 volstaat.
    const result = await askClaudeJson(
      prompt.content,
      `Thema van het lijstartikel: ${topic.title}\nTe verifiëren item: ${item.naam}${weekendContext(s.weekendgids)}\n\nTavily-bronnen:\n${sources.map((x, i) => `\n[${i + 1}] ${x.title}\n${x.url}\n${x.content.slice(0, VERIFY_SOURCE_CHARS)}`).join('\n')}`,
      false, FAST_WRITE_MODEL, 6000, LIST_VERIFY_SCHEMA,
    );
    if (str(result.status) === 'verified' && str(result.adres) && str(result.buurt)) {
      item.status = 'verified';
      item.adres = str(result.adres);
      item.buurt = str(result.buurt);
      item.extra_info = str(result.extra_info) || undefined;
      item.bron = str(result.bron) || undefined;
      item.feiten = str(result.feiten);
      const q = result.quote as any;
      item.quote = q && str(q.tekst) && str(q.bron) && quoteSourceAllowed(str(q.bron), constraints.quoteSourceBlacklist, str(q.herkomst))
        ? { tekst: str(q.tekst), bron: str(q.bron), herkomst: str(q.herkomst) || undefined }
        : null;
    } else {
      item.status = 'rejected';
      item.reden = str(result.reden) || 'Niet via een primaire bron te bevestigen';
    }
  }
  recount(s);
  const remaining = s.items.filter(i => i.status === 'pending').length;
  if (!remaining) {
    await saveTopicProgress(topic.id, { status: 'review', phase: 'review', state: s });
    return { topic, phase: 'review', done: true, progress: `Verificatie klaar: ${s.verified} opgenomen, ${s.rejected} afgevallen · wacht op controle` };
  }
  await saveTopicProgress(topic.id, { status: 'queued', state: s });
  return {
    topic, phase: 'verify', done: false,
    progress: `Item ${s.items.length - remaining}/${s.items.length} geverifieerd · ${s.rejected} afgevallen`,
  };
}

// Wordt aangeroepen vanuit de review-route zodra de redacteur items heeft
// goedgekeurd; zet de machine door naar de compositiefase.
export async function approveItems(topicId: number, includeNames: string[]): Promise<Topic> {
  const topic = await getTopic(topicId);
  if (!topic || topic.type !== 'lijst') throw new Error('Lijst-topic niet gevonden.');
  if (topic.status !== 'review') throw new Error('Dit lijstartikel wacht niet op itemcontrole.');
  const s = state(topic);
  const include = new Set(includeNames.map(n => n.toLocaleLowerCase('nl-NL')));
  for (const item of s.items) {
    if (item.status === 'excluded' && include.has(item.naam.toLocaleLowerCase('nl-NL'))) item.status = 'verified';
    else if (item.status === 'verified' && !include.has(item.naam.toLocaleLowerCase('nl-NL'))) {
      item.status = 'excluded';
      item.reden = 'Uitgesloten door de redactie';
    }
  }
  recount(s);
  if (s.items.filter(i => i.status === 'verified').length < 3) {
    throw new Error('Een lijstartikel heeft minimaal 3 goedgekeurde items nodig.');
  }
  await saveTopicProgress(topicId, { status: 'queued', phase: 'compose', state: s, errorClear: true });
  return (await getTopic(topicId))!;
}

// Compose stuurt de volledige lijst research in één Claude-call; bij veel
// items (elk met een lang "feiten"-researchblok) duurde die call langer dan
// de 60s function-timeout. De schrijfstap heeft niet de volledige
// researchtekst nodig om een beschrijving van 3-5 zinnen te schrijven — een
// bondige samenvatting per item volstaat en houdt de call snel, ongeacht het
// aantal items.
const MAX_FEITEN_CHARS = 500;

function trimFeiten(feiten: string | undefined): string {
  if (!feiten || feiten.length <= MAX_FEITEN_CHARS) return feiten || '';
  const cut = feiten.slice(0, MAX_FEITEN_CHARS);
  const lastSentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return (lastSentenceEnd > MAX_FEITEN_CHARS * 0.5 ? cut.slice(0, lastSentenceEnd + 1) : cut).trim();
}

function assertBatchComplete(items: any[], batch: ListItemState[]) {
  const expected = new Set(batch.map(item => item.naam.toLocaleLowerCase('nl-NL')));
  const returned = items.map(item => str(item?.naam).toLocaleLowerCase('nl-NL'));
  if (items.length !== batch.length || returned.some(name => !expected.has(name)) || new Set(returned).size !== batch.length) {
    throw new Error('Claude gaf niet precies één tekst terug voor elk item in dit schrijfblok.');
  }
  if (items.some(item => !str(item?.beschrijving))) {
    throw new Error('Claude liet een itembeschrijving leeg.');
  }
}

// Zelfs met getrimde research bleef één call voor alle items te traag bij
// veel items. De eerste schrijfstap maakt daarom de artikelstructuur en drie
// items. Vervolgstappen schrijven uitsluitend itemteksten: zij hoeven geen
// titel, intro, afsluiting, taxonomieën of de volledige lange schrijfprompt
// opnieuw te genereren.
//
// De zware eerste call (structuur + WP-taxonomie-fetch + 3 items) blijft op 3:
// een 4-item-versie hiervan zat live al op ~43s. De lichte vervolgcall mist die
// hele overhead (geen taxonomie-fetch, geen structuur-regeneratie, korte
// prompt, op 500 tekens getrimde research per item), dus die 43s-grens geldt
// er niet. 8 lichte items blijven ruim binnen de 60s (~2000 output-tokens, ver
// onder max_tokens 6000). Daarmee gaat een lijst van 11 items van drie
// (3+4+4) naar twee calls (3+8), met ook minder bloknaden (zie de quote-naad-
// afhandeling hieronder). Verlaag naar 6 als een lichte call ooit tegen de 60s
// aanloopt; bij een mislukte tik wordt alleen dat blok opnieuw geschreven.
const COMPOSE_FIRST_BATCH_SIZE = 3;
const COMPOSE_ITEMS_PER_TICK = 8;

const ITEM_COMPOSE_PROMPT = `Je bent journalist voor amsterdamnow.com. Schrijf uitsluitend de itemteksten voor een bestaand lijstartikel op basis van de aangeleverde, geverifieerde research.

Regels:
- Gebruik uitsluitend de aangeleverde feiten. Verzin niets en voeg geen items toe.
- Schrijf per item 3 tot 5 gewone, concrete Nederlandse zinnen. Noem geen adres; dat wordt apart geplaatst.
- Vermijd marketingtaal, superlatieven, de woorden hotspot, pareltje, bruisend, iconisch en gezellig, en em-dashes of en-dashes.
- Houd buurtnamen aan en gebruik geen stadsdelen als West, Zuid of Oost.
- Bepaal alleen of een aangeleverde, letterlijke quote na dit item past. Wijzig de quote nooit.

Geef uitsluitend geldige JSON terug, zonder markdown:
{"items":[{"naam":"exacte naam uit de research","beschrijving":"3-5 zinnen","plaats_quote":true}]}`;

// Maximaal aantal volledig afgekeurde compose-pogingen dat automatisch wordt
// herkanst (met de afkeurreden als extra instructie) voordat de run echt
// faalt. Voorkomt dat een structureel onhaalbare regel eindeloos tokens
// verbrandt.
const MAX_COMPOSE_ATTEMPTS = 3;

// Geeft de actieve Criteria-instellingen als beknopte instructieregels, zodat
// Claude de regels vooraf kent in plaats van pas achteraf een afkeuring te
// krijgen (en dan het hele artikel opnieuw te moeten schrijven — zie de
// feedback-loop verderop). Rechtstreeks uit ListConstraints opgebouwd i.p.v.
// de UI-labels uit criteria-fields.ts hergebruikt: die zijn geschreven voor
// een redacteur die een instellingenscherm leest, dit is een instructie voor
// het model.
function describeArticleConstraints(c: ListConstraints): string {
  const lines = [
    `- Titel: maximaal ${c.titleMaxChars} tekens.`,
    `- Introcontent: ${c.introSentences.min}-${c.introSentences.max} zinnen.`,
    `- Streef naar minimaal 1 quote per ${c.quoteNormPerItems} items, verspreid door het artikel.`,
    `- Noem in de afsluiting minimaal ${c.minNamedItemsInClosing} items bij naam.`,
  ];
  if (c.titleNoCount) lines.push('- Titel mag geen aantal bevatten (bv. "De 10 beste…"): de lijst kan later aangevuld worden.');
  if (c.subregelNoVanTotFormula) lines.push('- Subregel mag niet de vaste formule "van X tot Y" gebruiken.');
  if (c.subregelNoAmsterdamRepeat) lines.push('- Subregel mag "Amsterdam" niet herhalen als dat al in de titel staat.');
  return lines.join('\n');
}

function describeItemConstraints(c: ListConstraints): string {
  const lines = [`- Itembeschrijving: ${c.itemSentences.min}-${c.itemSentences.max} zinnen.`];
  if (c.noDashInText) lines.push('- Gebruik geen em-dash (—) of en-dash (–); gebruik komma\'s, dubbele punten of een nieuwe zin.');
  if (c.noBulletsInItem) lines.push('- Lopende tekst, geen opsommingen of bullets.');
  if (c.addressNotInDescription) lines.push('- Zet het adres NIET in de beschrijving; dat wordt apart getoond.');
  if (c.noConsecutiveQuotes) lines.push('- Zet nooit twee quotes bij opeenvolgende items.');
  if (c.forbiddenWords.length) lines.push(`- Gebruik nooit deze woorden/uitdrukkingen: ${c.forbiddenWords.join(', ')}.`);
  return lines.join('\n');
}

async function stepCompose(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const verified = s.items.filter(i => i.status === 'verified');
  if (verified.length < 3) throw new Error('Minder dan 3 goedgekeurde items over; artikel niet te schrijven.');
  const constraints = await activeConstraints('lijst');

  const chunks = s.composeChunks || [];
  const doneCount = chunks.reduce((n, c) => n + c.items.length, 0);
  const firstBatch = chunks.length === 0;
  const batchSize = firstBatch ? COMPOSE_FIRST_BATCH_SIZE : COMPOSE_ITEMS_PER_TICK;
  const nextBatch = verified.slice(doneCount, doneCount + batchSize);

  // Feedback-loop: werd een eerdere volledige poging afgekeurd door de
  // validatie, dan gaat de afkeurreden als expliciete instructie mee in élke
  // schrijfcall van de herkansing.
  const feedbackHint = s.composeFeedback
    ? `\n\nLET OP — de vorige versie van dit artikel werd afgekeurd om deze reden: "${s.composeFeedback}". Voorkom deze fout in wat je nu schrijft.`
    : '';
  const itemRulesHint = `\n\nHoud je aan deze regels:\n${describeItemConstraints(constraints)}`;

  if (nextBatch.length > 0) {
    const input = {
      thema: topic.title,
      weekendgids: s.weekendgids,
      items: nextBatch.map(i => ({
        naam: i.naam, feiten: trimFeiten(i.feiten), adres: i.adres, buurt: i.buurt,
        extra_info: i.extra_info || null,
        quote: i.quote ? { tekst: i.quote.tekst, bron: i.quote.bron } : null,
      })),
    };
    let result: Record<string, unknown>;
    if (firstBatch) {
      const [prompt, taxonomies] = await Promise.all([activePrompt('lijst-schrijf'), taxonomyChoices()]);
      result = await askClaudeJson(
        prompt.content,
        `Schrijf het lijstartikel. Kies "categories" (1-2) en "district" uit de beschikbare lijsten en kies 3-6 "tags" uitsluitend uit "beschikbare_tags" (nooit nieuwe tags verzinnen; laat "tags" leeg als er geen passen). Voeg ook een "rubriek" (Locatie of Evenement) toe aan je JSON-output, naast de velden uit je instructie.\n\nHoud je aan deze regels:\n${describeArticleConstraints(constraints)}\n${describeItemConstraints(constraints)}${feedbackHint}\n\n${JSON.stringify({
          ...input,
          beschikbare_categorieen: taxonomies.categories,
          beschikbare_districten: taxonomies.districts,
          beschikbare_tags: taxonomies.tags,
        })}`,
        false, FAST_WRITE_MODEL, 6000, LIST_COMPOSE_FIRST_SCHEMA
      );
    } else {
      // Elk blok kiest quote-plaatsing zonder de andere blokken te kennen.
      // Twee quotes op opeenvolgende items zou de validatie doen falen (en dan
      // alle blokken opnieuw laten schrijven). toValidated() is het harde
      // vangnet; deze hint houdt de plaatsing redactioneel netjes door het
      // eerste item van dit blok geen quote te laten openen als het vorige item
      // er al een kreeg.
      const prevItems = chunks[chunks.length - 1]?.items;
      const prevEndedWithQuote = Boolean(prevItems?.[prevItems.length - 1]?.plaats_quote);
      const naadHint = prevEndedWithQuote
        ? '\n\nHet vorige item eindigde met een quote; zet daarom géén quote op het eerste item van dit blok.'
        : '';
      result = await askClaudeJson(
        ITEM_COMPOSE_PROMPT,
        `Thema van het lijstartikel: ${topic.title}\n\nSchrijf precies ${nextBatch.length} volgende items, in exact deze volgorde: ${nextBatch.map(item => item.naam).join(', ')}.${naadHint}${itemRulesHint}${feedbackHint}\n\n${JSON.stringify(input)}`,
        false, FAST_WRITE_MODEL, 6000, LIST_COMPOSE_ITEMS_SCHEMA
      );
    }
    const items = Array.isArray(result.items) ? result.items : [];
    assertBatchComplete(items, nextBatch);
    chunks.push({
      title: str(result.title),
      subregel: str(result.subregel),
      introcontent: str(result.introcontent),
      inleiding: str(result.inleiding),
      afsluiting: str(result.afsluiting),
      items: items.map((i: any) => ({ naam: str(i.naam), beschrijving: str(i.beschrijving), plaats_quote: Boolean(i.plaats_quote) })),
      categories: Array.isArray(result.categories) ? result.categories.map(str).filter(Boolean) : [],
      district: str(result.district),
      tags: Array.isArray(result.tags) ? result.tags.map(str).filter(Boolean) : [],
      rubriek: str(result.rubriek) || 'Locatie',
    });
    s.composeChunks = chunks;
    const newDoneCount = doneCount + nextBatch.length;
    if (newDoneCount < verified.length) {
      await saveTopicProgress(topic.id, { status: 'queued', state: s });
      return { topic, phase: 'compose', done: false, progress: `Artikel wordt geschreven · ${newDoneCount}/${verified.length} items` };
    }
  }

  const composed: ComposedList = { ...chunks[0], items: chunks.flatMap(c => c.items) };
  if (!composed.title || !composed.items.length) throw new Error('De compositiefase gaf geen volledig artikel terug.');

  // Koppel de compositie terug aan de geverifieerde research en dwing de
  // redactionele regels af in code (quotes letterlijk, spreiding, verboden woorden).
  // `constraints` is dezelfde actieve set als hierboven al aan Claude is
  // meegegeven — één keer opgehaald per compose-run.
  const validated = toValidated(composed, verified, constraints.noConsecutiveQuotes);
  let meldingen: string[];
  try {
    meldingen = validateListArticle(validated, constraints);
  } catch (err: any) {
    // Feedback-loop: wis de afgekeurde blokken en laat de volgende tikken het
    // artikel automatisch opnieuw schrijven, met de afkeurreden als expliciete
    // instructie in de prompt. Pas na MAX_COMPOSE_ATTEMPTS volledig afgekeurde
    // pogingen faalt de run echt.
    const attempts = (s.composeAttempts || 0) + 1;
    s.composeChunks = undefined;
    if (attempts >= MAX_COMPOSE_ATTEMPTS) {
      s.composeFeedback = undefined;
      s.composeAttempts = undefined;
      await saveTopicProgress(topic.id, { state: s });
      throw new Error(`${err?.message || err} (na ${attempts} schrijfpogingen)`);
    }
    s.composeFeedback = String(err?.message || err);
    s.composeAttempts = attempts;
    await saveTopicProgress(topic.id, { status: 'queued', state: s });
    return {
      topic, phase: 'compose', done: false,
      progress: `Afgekeurd (${s.composeFeedback.slice(0, 60)}…) · herkansing ${attempts + 1}/${MAX_COMPOSE_ATTEMPTS} start`,
    };
  }
  s.artikel = composed;
  s.meldingen = meldingen;
  s.composeChunks = undefined;
  s.composeFeedback = undefined;
  s.composeAttempts = undefined;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'finalize', state: s });
  return { topic, phase: 'finalize', done: false, progress: 'Artikel geschreven en gevalideerd · afronden' };
}

function findResearch(verified: ListItemState[], naam: string): ListItemState {
  const key = naam.toLocaleLowerCase('nl-NL');
  const hit = verified.find(v => v.naam.toLocaleLowerCase('nl-NL') === key)
    || verified.find(v => key.includes(v.naam.toLocaleLowerCase('nl-NL')) || v.naam.toLocaleLowerCase('nl-NL').includes(key));
  if (!hit) throw new Error(`Compositie bevat item "${naam}" dat niet in de geverifieerde research zit.`);
  return hit;
}

function toValidated(composed: ComposedList, verified: ListItemState[], noConsecutiveQuotes: boolean): GeneratedListArticle {
  // Compose kiest quote-plaatsing per blok, zonder de andere blokken te kennen.
  // Wanneer de regel "geen twee quotes op opeenvolgende items" actief is, dwingt
  // deze lus dat hard af: een quote die direct op een vorige quote zou volgen
  // (typisch over een bloknaad) wordt onderdrukt. Zonder dit vangnet zou de
  // validatie falen en zouden álle compose-blokken opnieuw geschreven worden.
  let prevHadQuote = false;
  const items = composed.items.map(item => {
    const research = findResearch(verified, item.naam);
    const wantsQuote = Boolean(item.plaats_quote && research.quote);
    const quote = wantsQuote && !(noConsecutiveQuotes && prevHadQuote) && research.quote
      ? { tekst: research.quote.tekst, bron: research.quote.bron }
      : null;
    prevHadQuote = quote !== null;
    return {
      naam: item.naam,
      beschrijving: item.beschrijving,
      adres: research.adres || '',
      buurt: research.buurt || '',
      quote,
    };
  });
  return {
    title: composed.title,
    subregel: composed.subregel,
    introcontent: composed.introcontent,
    inleiding: composed.inleiding,
    afsluiting: composed.afsluiting,
    items,
  };
}

async function stepFinalize(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const composed = s.artikel;
  if (!composed) throw new Error('Geen gecomponeerd artikel in de state.');
  const verified = s.items.filter(i => i.status === 'verified');

  const structure: ListArticleStructure = {
    postId: 0,
    introcontent: composed.introcontent,
    inleiding: composed.inleiding,
    afsluiting: composed.afsluiting,
    meldingen: s.meldingen,
    items: await Promise.all(composed.items.map(async item => {
      const research = findResearch(verified, item.naam);
      return {
        naam: item.naam,
        beschrijving: item.beschrijving,
        adres: research.adres || '',
        buurt: research.buurt || '',
        extra_info: research.extra_info,
        interne_link: (await findArticleLink(item.naam)) || undefined,
        quote: item.plaats_quote && research.quote ? { tekst: research.quote.tekst, bron: research.quote.bron } : null,
        media: null,
      };
    })),
  };

  const seoPrompt = await activePrompt('lijst-seo');
  const seo = await askClaudeJson(
    seoPrompt.content,
    `Onderwerp: ${topic.title}\nTitel: ${composed.title}\nIntro: ${composed.introcontent}\nItems: ${structure.items.map(i => i.naam).join(', ')}`,
    false, FAST_WRITE_MODEL, 6000, SEO_SCHEMA,
  );

  const draft = await createDraft({
    title: composed.title,
    subregel: composed.subregel,
    intro: composed.introcontent,
    contentHtml: assembleListHtml(structure),
    quote: structure.items.find(i => i.quote)?.quote?.tekst || '',
    focusKeyword: str(seo.rank_math_focus_keyword),
    slug: str(seo.slug),
    seoTitle: str(seo.rank_math_title),
    metaDescription: str(seo.rank_math_description),
    categories: composed.categories.length ? composed.categories : ['Buurten'],
    district: composed.district || 'Amsterdam Centrum',
    tags: composed.tags,
    rubriek: composed.rubriek,
    naamLocatie: '',
    adres: '',
    stad: 'Amsterdam',
    website: '',
  });
  structure.postId = draft.id;
  await saveListStructure(draft.id, topic.id, structure);
  await completeTopic(topic.id, draft.id);
  return {
    topic, phase: 'finalize', done: true,
    progress: 'Draft aangemaakt', article: { id: draft.id, title: draft.title },
  };
}
