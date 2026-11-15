import { legalEntity } from './legal'

// Each page's document title names the page, then the product (WCAG 2.4.2): a route's `head`
// returns `pageTitle(<its heading>)`, overriding the root's title. A product renames itself in
// `legalEntity` (lib/legal.ts).
export const productTitle = legalEntity.product

export const pageTitle = (page: string) => ({ meta: [{ title: `${page} · ${productTitle}` }] })
