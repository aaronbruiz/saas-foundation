// ADR-0028: the product's public docs, a static Starlight site served by its own assets-only
// Worker. English is the root locale, so adding locales later doesn't move existing URLs.
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://docs.aaronlabr.dev',
  integrations: [
    starlight({
      title: 'SaaS Foundation',
      locales: { root: { label: 'English', lang: 'en' } },
      customCss: ['./src/styles/theme.css'],
      sidebar: [{ label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] }],
    }),
  ],
})
