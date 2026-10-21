import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://github.com/Msalways/hattera'),
  title: {
    default: 'Hattera Docs',
    template: '%s · Hattera Docs',
  },
  description: 'Set up and use your self-hosted Hattera server.',
  openGraph: {
    title: 'Hattera Docs',
    description: 'Your own self-hosted AI agent chat workspace.',
    type: 'website',
  },
  icons: {
    icon: '/hattera-mark.svg',
    apple: '/hattera-mark.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
