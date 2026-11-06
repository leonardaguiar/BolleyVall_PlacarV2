import './globals.css';
import Script from 'next/script';

export const metadata = {
  title: 'BolleyVall Placar',
  description: 'Placar e organização de jogos recreativos de vôlei.',
  manifest: '/manifest.json',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  userScalable: false,
  themeColor: '#12161B',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>
        <Script src="/armazenamento-local.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}