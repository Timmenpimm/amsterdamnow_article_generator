import {
  activeConstraints, activeListTopic, activePrompt, claimNextListTopic, completeTopic, failTopic,
  getTopic, saveListProgress, saveListStructure,
} from './db';
import { askClaudeJson } from './claude';
import { researchWithTavily } from './tavily';
import { createDraft, findArticleLink, taxonomyChoices } from './wp';
import { assembleListHtml } from './listHtml';
import { quoteSourceAllowed, validateListArticle, type GeneratedListArticle } from './validation';
import type { ComposedList, ListArticleStructure, ListItemState, ListState, Topic } from './types';

const VERIFY_PER_TICK = 2; // items per aanroep, zodat elke stap binnen de serverless-limiet blijft

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
    `Thema van het lijstartikel: ${topic.title}${weekendContext(s.weekendgids)}\n\nTavily-bronnen:\n${sources.map((x, i) => `\n[${i + 1}] ${x.title}\n${x.url}\n${x.content.slice(0, 6000)}`).join('\n')}`
  );
  const kandidaten = Array.isArray(result.kandidaten) ? result.kandidaten : [];
  const items: ListItemState[] = kandidaten
    .map((k: any) => ({ naam: str(k.naam), status: 'pending' as const }))
    .filter((k: ListItemState) => k.naam);
  if (items.length < 3) throw new Error('De selectiefase leverde minder dan 3 kandidaat-items op.');
  s.items = items;
  await saveListProgress(topic.id, { phase: 'verify', state: s });
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
    await saveListProgress(topic.id, { status: 'review', phase: 'review', state: s });
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
    const result = await askClaudeJson(
      prompt.content,
      `Thema van het lijstartikel: ${topic.title}\nTe verifiëren item: ${item.naam}${weekendContext(s.weekendgids)}\n\nTavily-bronnen:\n${sources.map((x, i) => `\n[${i + 1}] ${x.title}\n${x.url}\n${x.content.slice(0, 8000)}`).join('\n')}`
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
    await saveListProgress(topic.id, { status: 'review', phase: 'review', state: s });
    return { topic, phase: 'review', done: true, progress: `Verificatie klaar: ${s.verified} opgenomen, ${s.rejected} afgevallen · wacht op controle` };
  }
  await saveListProgress(topic.id, { state: s });
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
  await saveListProgress(topicId, { status: 'writing', phase: 'compose', state: s, errorClear: true });
  return (await getTopic(topicId))!;
}

async function stepCompose(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const verified = s.items.filter(i => i.status === 'verified');
  if (verified.length < 3) throw new Error('Minder dan 3 goedgekeurde items over; artikel niet te schrijven.');
  const [prompt, taxonomies, constraints] = await Promise.all([
    activePrompt('lijst-schrijf'), taxonomyChoices(), activeConstraints('lijst'),
  ]);
  const input = {
    thema: topic.title,
    weekendgids: s.weekendgids,
    beschikbare_categorieen: taxonomies.categories,
    beschikbare_districten: taxonomies.districts,
    items: verified.map(i => ({
      naam: i.naam, feiten: i.feiten, adres: i.adres, buurt: i.buurt,
      extra_info: i.extra_info || null,
      quote: i.quote ? { tekst: i.quote.tekst, bron: i.quote.bron } : null,
    })),
  };
  const result = await askClaudeJson(
    prompt.content,
    `Schrijf het lijstartikel. Kies "categories" (1-2) en "district" uit de beschikbare lijsten en voeg 3-6 "tags" en een "rubriek" (Locatie of Evenement) toe aan je JSON-output, naast de velden uit je instructie.\n\n${JSON.stringify(input)}`
  );
  const items = Array.isArray(result.items) ? result.items : [];
  const composed: ComposedList = {
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
  };
  if (!composed.title || !composed.items.length) throw new Error('De compositiefase gaf geen volledig artikel terug.');

  // Koppel de compositie terug aan de geverifieerde research en dwing de
  // redactionele regels af in code (quotes letterlijk, spreiding, verboden woorden).
  const validated = toValidated(composed, verified);
  const meldingen = validateListArticle(validated, constraints);
  s.artikel = composed;
  s.meldingen = meldingen;
  await saveListProgress(topic.id, { phase: 'finalize', state: s });
  return { topic, phase: 'finalize', done: false, progress: 'Artikel geschreven en gevalideerd · afronden' };
}

function findResearch(verified: ListItemState[], naam: string): ListItemState {
  const key = naam.toLocaleLowerCase('nl-NL');
  const hit = verified.find(v => v.naam.toLocaleLowerCase('nl-NL') === key)
    || verified.find(v => key.includes(v.naam.toLocaleLowerCase('nl-NL')) || v.naam.toLocaleLowerCase('nl-NL').includes(key));
  if (!hit) throw new Error(`Compositie bevat item "${naam}" dat niet in de geverifieerde research zit.`);
  return hit;
}

function toValidated(composed: ComposedList, verified: ListItemState[]): GeneratedListArticle {
  return {
    title: composed.title,
    subregel: composed.subregel,
    introcontent: composed.introcontent,
    inleiding: composed.inleiding,
    afsluiting: composed.afsluiting,
    items: composed.items.map(item => {
      const research = findResearch(verified, item.naam);
      return {
        naam: item.naam,
        beschrijving: item.beschrijving,
        adres: research.adres || '',
        buurt: research.buurt || '',
        quote: item.plaats_quote && research.quote ? { tekst: research.quote.tekst, bron: research.quote.bron } : null,
      };
    }),
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
    `Onderwerp: ${topic.title}\nTitel: ${composed.title}\nIntro: ${composed.introcontent}\nItems: ${structure.items.map(i => i.naam).join(', ')}`
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
