import { claimNextQueued, recoverStaleTopics } from './db';
import { processListStep } from './listWriter';
import { writeTopic } from './writer';

// Verwerkt hooguit één atomisch geclaimde taak. Zowel het bord als de cron
// worker gebruiken deze functie, zodat browserinteractie niet meer bepalend
// is voor het voortzetten van de wachtrij.
export async function processNextQueueJob() {
  const recovered = await recoverStaleTopics();
  const next = await claimNextQueued();
  if (!next) return { topic: null, article: null, recovered };
  if (next.type === 'lijst') {
    const step = await processListStep(next.id);
    return { list: step, topic: step?.topic ?? null, article: step?.article ?? null, recovered };
  }
  return { ...(await writeTopic(next)), recovered };
}
