// ADR-0033: the product's marketing site, static, served by its own assets-only Worker on the apex.
// No client scripts and external stylesheets only, so the CSP in public/_headers needs no
// 'unsafe-inline'.
import sitemap from '@astrojs/sitemap'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://aaronlabr.dev',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'never' },
  integrations: [sitemap()],
})
