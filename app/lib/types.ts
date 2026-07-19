export type TopicStatus = 'queued' | 'writing' | 'failed' | 'done';

export interface Topic {
  id: number;
  title: string;
  status: TopicStatus;
  sort: number;
  created_at: string;
  started_at: string | null;
  error: string | null;
  error_step: string | null;
  attempts: number;
  post_id: number | null;
}

export interface MediaRef {
  id: number;
  url: string;
}

export type ArticleStatus = 'draft' | 'publish';

export interface Article {
  id: number;
  title: string;
  subregel: string;
  intro: string;
  contentHtml: string;
  status: ArticleStatus;
  link: string;
  modified: string;
  date: string;
  category: string;
  district: string;
  rubriek: string;
  featured: MediaRef | null;
  slider: MediaRef[];
  fotograaf: string;
  naam_locatie: string;
  adres: string;
  stad: string;
  website: string;
  cordA: string;
  cordB: string;
  tags: string[];
  focusKeyword: string;
  slug: string;
  seoTitle: string;
  metaDescription: string;
  flags: {
    new_in_town: boolean;
    featured_item: boolean;
    beste_van_amsterdam: boolean;
    homepage_carousel: boolean;
  };
}

export const REQUIRED_IMAGES = 3;

export function imageCount(a: Pick<Article, 'featured' | 'slider'>): number {
  return (a.featured ? 1 : 0) + a.slider.length;
}

export type ArticlePhase = 'needImages' | 'ready' | 'published';

export function articlePhase(a: Article): ArticlePhase {
  if (a.status === 'publish') return 'published';
  return imageCount(a) >= REQUIRED_IMAGES ? 'ready' : 'needImages';
}

export interface PromptVersion {
  id: number;
  kind: 'schrijf' | 'seo';
  version: number;
  content: string;
  note: string;
  author: string;
  created_at: string;
  active: 0 | 1;
}

export interface BoardData {
  mode: 'live' | 'demo';
  storage?: 'postgres' | 'sqlite';
  persistent?: boolean;
  topics: Topic[];
  articles: Article[];
}
