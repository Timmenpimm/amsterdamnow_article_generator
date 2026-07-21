import TopBar from '@/components/TopBar';
import CarouselGenerator from '@/components/CarouselGenerator';

export default async function CarouselArticlePage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  return (
    <div style={{ minHeight: '100vh' }}>
      <TopBar />
      <CarouselGenerator articleId={Number(articleId)} />
    </div>
  );
}
