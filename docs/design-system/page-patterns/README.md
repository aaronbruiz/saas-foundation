# Page patterns

How a whole page is put together, from the frames that exist. Pick the frame first (the `ui-page` skill), then the patterns its actions need. No generic page-layout component exists; each frame is code you reuse, not copy ([layout](../foundations/layout.md#frames)).

| Page pattern                                      | Frame                       | Routes                                                     |
| ------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| [Authentication](authentication.md)               | `AuthLayout`                | `/login`, `/signup`, `/forgot-password`, `/reset-password` |
| [Onboarding](onboarding.md)                       | `AuthLayout`                | `/` (landing), `/orgs/new`, `/invite/<id>`                 |
| [Collection and detail](collection-and-detail.md) | tenant shell                | `/t/<slug>/projects`, `/t/<slug>/projects/<id>`, members   |
| [Settings](settings.md)                           | tenant shell, account frame | `/t/<slug>/settings`, `/t/<slug>/billing`, `/account`      |

Every page pattern lists its purpose, frame, composition, primary actions, navigation, its states (denied, empty, error, loading where they apply) and the patterns and components it uses. Legal pages (`/privacy`, `/terms`, `/subprocessors`) use `LegalPage` and have no actions.
