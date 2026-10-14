// Better Auth configuration (server only). Mounted at apps/app/src/routes/api/auth/$.ts.
export {
  BOT_PROTECTED_PATHS,
  BOT_PROTECTION_ACTIONS,
  createAuth,
  type Auth,
  type AuthOptions,
  type AuthEmail,
  type BotProtection,
} from './auth.ts'
