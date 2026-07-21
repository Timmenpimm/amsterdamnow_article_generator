'use client';

import TopBar from '@/components/TopBar';
import CarouselOverview from '@/components/CarouselOverview';

export default function CarouselPage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <TopBar />
      <CarouselOverview />
    </div>
  );
}
