import ArticleDetail from '@/components/ArticleDetail';

export default async function ArtikelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ArticleDetail id={Number(id)} />;
}
