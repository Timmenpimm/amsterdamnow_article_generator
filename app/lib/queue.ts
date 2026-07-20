import { claimNextQueued, recoverStaleTopics } from './db';
import { processListStep } from './listWriter';
import { processStandaardStep } from './writer';

// Verwerkt hooguit één atomisch geclaimde fase-stap. Zowel het bord als de
// cron worker gebruiken deze functie, zodat browserinteractie niet meer
// bepalend is voor het voortzetten van de wachtrij. Beide pipelines (lijst en
// standaard) zijn fase-gebaseerd: elke stap blijft op zichzelf staand binnen
// de 60s-serverless-limiet, en zet het topic tussen stappen terug op
// 'queued' zodat de volgende aanroep 'm via claimNextQueued() weer oppakt.
export async function processNextQueueJob() {
  const recovered = await recoverStaleTopics();
  const next = await claimNextQueued();
  if (!next) return { topic: null, article: null, recovered };
  if (next.type === 'lijst') {
    const step = await processListStep(next.id);
    return { list: step, topic: step?.topic ?? null, article: step?.article ?? null, recovered };
  }
  const step = await processStandaardStep(next);
  return { standaard: step, topic: step.topic, article: step.article ?? null, recovered };
}
