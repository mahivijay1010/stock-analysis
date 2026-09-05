import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Backdrop } from '@/components/Backdrop';

export const metadata: Metadata = {
  title: 'StockSense — Indian Market Intelligence',
  description:
    'Quantitative analysis for NSE stocks — honest forecasts with 80% confidence ranges, measured backtest accuracy, and INR projections.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const themeScript = `
    (function () {
      try {
        var requested = new URLSearchParams(window.location.search).get('theme');
        var saved = localStorage.getItem('stocksense.theme');
        var theme = requested === 'light' || requested === 'dark'
          ? requested
          : (saved === 'light' || saved === 'dark'
            ? saved
            : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
        var root = document.documentElement;
        root.dataset.theme = theme;
        root.classList.toggle('dark', theme === 'dark');
        root.style.colorScheme = theme;
      } catch (_) {}
    })();
  `;

  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body className="antialiased">
        <Backdrop />
        <div className="relative z-10">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
