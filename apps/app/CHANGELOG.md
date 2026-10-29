# Changelog

## [0.5.0](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.4.1...app-v0.5.0) (2026-10-29)


### Features

* **app:** database-free /api/ping for uptime monitoring ([fdba3dd](https://github.com/aaronbruiz/saas-foundation/commit/fdba3dd03c4f6bb45f58978081b1bcd5f04d7d3e))
* **app:** error page for loader failures, rendered on the server too ([37d8d9f](https://github.com/aaronbruiz/saas-foundation/commit/37d8d9f81094ecf58ca5fce89cbd72d49e6a4df5))


### Bug Fixes

* **db:** bound how long a migration waits for locks ([#207](https://github.com/aaronbruiz/saas-foundation/issues/207)) ([e4acd06](https://github.com/aaronbruiz/saas-foundation/commit/e4acd06363a833b097139c45de59962a9693d24b))

## [0.4.1](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.4.0...app-v0.4.1) (2026-10-29)


### Bug Fixes

* **app:** send unexpected server-function errors to the client as a generic message ([ead359c](https://github.com/aaronbruiz/saas-foundation/commit/ead359c8ec1b199f53110fb25fbe80c3fc64804e))
* **deps:** bump the production-minor-and-patch group across 1 directory with 6 updates ([#181](https://github.com/aaronbruiz/saas-foundation/issues/181)) ([1857f45](https://github.com/aaronbruiz/saas-foundation/commit/1857f451a79fdb6d671d3edcf96481e64460ee2b))
* **deps:** update seroval to 1.7.5 in TanStack Start's request path ([5207886](https://github.com/aaronbruiz/saas-foundation/commit/52078860a9d155fa4f0fe3475b510ba50ace7f53))


### Performance

* **projects:** read the plan inside the creating transaction ([#189](https://github.com/aaronbruiz/saas-foundation/issues/189)) ([cf6d01b](https://github.com/aaronbruiz/saas-foundation/commit/cf6d01bb36361e55ff9e1f158ad025632c7321f6))

## [0.4.0](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.3.2...app-v0.4.0) (2026-10-21)


### Features

* **auth:** store password-reset identifiers hashed ([#160](https://github.com/aaronbruiz/saas-foundation/issues/160)) ([1f007a3](https://github.com/aaronbruiz/saas-foundation/commit/1f007a38e0afdba1c5b58e2692d2682722b2d1b8))
* **db:** add a least-privilege runtime role for the app ([#149](https://github.com/aaronbruiz/saas-foundation/issues/149)) ([f4be919](https://github.com/aaronbruiz/saas-foundation/commit/f4be9191eab91bb16725a6e42288fe1f7154772e))
* **db:** add owner-owned archive and audit triggers ([#159](https://github.com/aaronbruiz/saas-foundation/issues/159)) ([1315f89](https://github.com/aaronbruiz/saas-foundation/commit/1315f89414acdc0ca2e34445c01caf3b81172239))
* **db:** answer the webhook subscription conflict through an owner-owned definer function ([#162](https://github.com/aaronbruiz/saas-foundation/issues/162)) ([1e3f3b7](https://github.com/aaronbruiz/saas-foundation/commit/1e3f3b7b60794ad75b7f0d9c00653a5f93729fa6))
* **db:** run tenant repositories in guarded transaction-local tenant context ([#161](https://github.com/aaronbruiz/saas-foundation/issues/161)) ([42e3a15](https://github.com/aaronbruiz/saas-foundation/commit/42e3a1545b7688039d2d6e31f7e9788fd3b72968))


### Bug Fixes

* **auth:** make organization deletion database-atomic ([#155](https://github.com/aaronbruiz/saas-foundation/issues/155)) ([3e4f613](https://github.com/aaronbruiz/saas-foundation/commit/3e4f6132821af0a68dc52c67b66ed08fef255427))
* **backup:** harden manual backup execution ([#156](https://github.com/aaronbruiz/saas-foundation/issues/156)) ([dbd90cb](https://github.com/aaronbruiz/saas-foundation/commit/dbd90cbcc317ae7b7ee42543f03e472ff0e841f0))
* **db:** let db:check find its base without origin/main ([#170](https://github.com/aaronbruiz/saas-foundation/issues/170)) ([f9cee85](https://github.com/aaronbruiz/saas-foundation/commit/f9cee85f160bf0e7432dd32b939c561fa195ee97))
* **db:** remove unlocked projects.create; regenerate worker types ([#139](https://github.com/aaronbruiz/saas-foundation/issues/139)) ([f4782ef](https://github.com/aaronbruiz/saas-foundation/commit/f4782ef9a40bf540d642fa621de0adfb37e045c4))
* **deps:** bump the better-auth group with 2 updates ([#157](https://github.com/aaronbruiz/saas-foundation/issues/157)) ([24e3d99](https://github.com/aaronbruiz/saas-foundation/commit/24e3d99346fde8749be0772342ab331250af0a09))


### Refactoring

* **env:** type optional Worker vars once ([#153](https://github.com/aaronbruiz/saas-foundation/issues/153)) ([8c1c472](https://github.com/aaronbruiz/saas-foundation/commit/8c1c4723e289b5a3f7a44d7c25e79f1ec0529aea))
* **scripts:** fix shellcheck warnings in the static-site build check ([#143](https://github.com/aaronbruiz/saas-foundation/issues/143)) ([ebd108f](https://github.com/aaronbruiz/saas-foundation/commit/ebd108f279b246c07b1bd2a6f31bc2e07cd507f2))

## [0.3.2](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.3.1...app-v0.3.2) (2026-10-14)


### Bug Fixes

* **app:** answer unknown server-function ids with 404 ([#130](https://github.com/aaronbruiz/saas-foundation/issues/130)) ([1f74f80](https://github.com/aaronbruiz/saas-foundation/commit/1f74f80c40745b36dff4f0a3cd6eafaeb0693cf3))

## [0.3.1](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.3.0...app-v0.3.1) (2026-10-14)


### Bug Fixes

* **deps:** bump zod from 4.6.5 to 4.6.6 in the production-minor-and-patch group ([#126](https://github.com/aaronbruiz/saas-foundation/issues/126)) ([279b7c3](https://github.com/aaronbruiz/saas-foundation/commit/279b7c323937573ea4de37fb00a71c8e3e62752e))

## [0.3.0](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.2.0...app-v0.3.0) (2026-10-14)


### Features

* **site:** marketing site on the apex with pricing from the billing policy ([#124](https://github.com/aaronbruiz/saas-foundation/issues/124)) ([51b891f](https://github.com/aaronbruiz/saas-foundation/commit/51b891f5c6fe3800af335d05c35e4839dcd92bcf))


### Refactoring

* **ci:** one shared pipeline for the static sites (ADR-0033) ([#123](https://github.com/aaronbruiz/saas-foundation/issues/123)) ([88208fe](https://github.com/aaronbruiz/saas-foundation/commit/88208fe661f2edaac3e319dc72196a557d7c7cb7))
* **repo:** rename the web app to app (ADR-0033) ([#122](https://github.com/aaronbruiz/saas-foundation/issues/122)) ([f7aee8a](https://github.com/aaronbruiz/saas-foundation/commit/f7aee8a448488313c2b208747a4f19849bfe132e))

## [0.2.0](https://github.com/aaronbruiz/saas-foundation/compare/web-v0.1.0...web-v0.2.0) (2026-10-14)


### Features

* **health:** report version, commit and build id in /api/health ([#96](https://github.com/aaronbruiz/saas-foundation/issues/96)) ([a32fd82](https://github.com/aaronbruiz/saas-foundation/commit/a32fd8262ebcd7ef1f92dbe5bcf19f5c18a34bd3))


### Bug Fixes

* **deps:** bump the production-minor-and-patch group with 3 updates ([#99](https://github.com/aaronbruiz/saas-foundation/issues/99)) ([57129ac](https://github.com/aaronbruiz/saas-foundation/commit/57129ac7565cd7e68f31d9a64e9cc1749ba17498))
