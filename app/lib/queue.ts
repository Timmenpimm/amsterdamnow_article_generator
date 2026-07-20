import { claimActiveListTopic, claimNextQueued, recoverStaleTopics, releaseTopicLock } from './db';
import { processListStep } from './listWriter';
import { writeTopic } from './writer';

// Verwerkt hooguit één atomisch geclaimde taak. Zowel het bord als de cron
// worker gebruiken deze functie, zodat browserinteractie niet meer bepalend
// is voor het voortzetten van de wachtrij.
export async function processNextQueueJob() {
  const recovered = await recoverStaleTopics();
  const running = await claimActiveListTopic();
  if (running) {
    try {
      const step = await processListStep(running.id);
      return { list: step, topic: step?.topic ?? null, article: step?.article ?? null, recovered };
    } finally {
      await releaseTopicLock(running.id);
    }
  }

  const next = await claimNextQueued();
  if (!next) return { topic: null, article: null, recovered };
  if (next.type === 'lijst') {
    try {
      const step = await processListStep(next.id);
      return { list: step, topic: step?.topic ?? null, article: step?.article ?? null, recovered };
    } finally {
      await releaseTopicLock(next.id);
    }
  }
  return { ...(await writeTopic(next)), recovered };
}
