import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastHost } from '@/components/toast';

export const metadata: Metadata = {
  title: 'AmsterdamNOW Artikel-tool',
  description: 'Redactietool voor de AI-artikelpipeline van amsterdamnow.com',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <ToastHost />
      </body>
    </html>
  );
}
