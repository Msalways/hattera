import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BrandTitle } from '@/components/brand-title';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <BrandTitle />,
      url: '/docs',
      transparentMode: 'none',
    },
    links: [
      { text: 'Setup', url: '/docs/setup' },
      { text: 'Hosting', url: '/docs/hosting' },
      { type: 'button', text: 'Source', url: 'https://github.com/Msalways/hattera', external: true },
    ],
    githubUrl: 'https://github.com/Msalways/hattera',
  };
}
