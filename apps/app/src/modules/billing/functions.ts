import { createServerFn } from '@tanstack/react-start'
import { StartCheckoutInput, TenantInput } from '@saas-foundation/contracts'
import { requestHeaders, serve } from '../../server/boundary'
import { validateWith } from '../../server/validate'
import { getBillingOverview, openBillingPortal, startCheckout } from './service'

// Thin adapters (see projects/functions.ts): every call carries `tenant`; the service re-verifies.
export const getBillingFn = createServerFn({ method: 'GET' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => getBillingOverview(requestHeaders(), data)))
export const startCheckoutFn = createServerFn({ method: 'POST' })
  .validator(validateWith(StartCheckoutInput))
  .handler(({ data }) => serve(() => startCheckout(requestHeaders(), data)))
export const openBillingPortalFn = createServerFn({ method: 'POST' })
  .validator(validateWith(TenantInput))
  .handler(({ data }) => serve(() => openBillingPortal(requestHeaders(), data)))
