import { withSiteverify } from './turnstile-fake'

// ADR-0025: siteverify is answered locally in every test file (see turnstile-fake.ts). Tests that
// stub fetch themselves wrap their stub in `withSiteverify` too.
globalThis.fetch = withSiteverify(globalThis.fetch.bind(globalThis))
