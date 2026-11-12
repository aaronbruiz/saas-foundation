# Changelog

## [0.6.0](https://github.com/aaronbruiz/saas-foundation/compare/app-v0.5.0...app-v0.6.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **account:** self-service account deactivation, eligible for purge after 90 days ([#237](https://github.com/aaronbruiz/saas-foundation/issues/237))

### Features

* **account:** organization menu and account page ([#231](https://github.com/aaronbruiz/saas-foundation/issues/231)) ([55fd9cf](https://github.com/aaronbruiz/saas-foundation/commit/55fd9cfe328d4ef412ab604826ffcdfcaab23233))
* **account:** self-service account deactivation, eligible for purge after 90 days ([#237](https://github.com/aaronbruiz/saas-foundation/issues/237)) ([ad32b8c](https://github.com/aaronbruiz/saas-foundation/commit/ad32b8c75fd3740d7c8cb133e2a859e3fbb606aa))
* **agents:** coordinated workflow with parallel workers, trial skills and permission rules ([#226](https://github.com/aaronbruiz/saas-foundation/issues/226)) ([4fdb2d3](https://github.com/aaronbruiz/saas-foundation/commit/4fdb2d3523a60448e2fd340a485921ec00ef2d4c))
* **app:** account and legal pages on the UI foundation ([#259](https://github.com/aaronbruiz/saas-foundation/issues/259)) ([6080b3c](https://github.com/aaronbruiz/saas-foundation/commit/6080b3c6c1465fa44f59d587f54f9874e9a0375b))
* **app:** auth and onboarding pages on the UI foundation ([#258](https://github.com/aaronbruiz/saas-foundation/issues/258)) ([52d128d](https://github.com/aaronbruiz/saas-foundation/commit/52d128d2cdacad537c284a1c15d2d8cad18069c1))
* **app:** confirm ownership transfers and tidy the settings page ([#275](https://github.com/aaronbruiz/saas-foundation/issues/275)) ([345fb0e](https://github.com/aaronbruiz/saas-foundation/commit/345fb0e57e2a8379d5b8426e4b247d9afb3bf862))
* **app:** follow the system theme and drop the legacy UI helpers ([#261](https://github.com/aaronbruiz/saas-foundation/issues/261)) ([94537e1](https://github.com/aaronbruiz/saas-foundation/commit/94537e114d63f50625b1d9b4c7f397b949a85475))
* **app:** group the tenant nav, mark the organization switcher and align the footer ([#274](https://github.com/aaronbruiz/saas-foundation/issues/274)) ([4074176](https://github.com/aaronbruiz/saas-foundation/commit/4074176d5cc6a9b6d709f4ddca8fbc555a97d5fe))
* **app:** tenant pages on the UI foundation ([#257](https://github.com/aaronbruiz/saas-foundation/issues/257)) ([874ea78](https://github.com/aaronbruiz/saas-foundation/commit/874ea787f32f8b4075a9766dfd1852235976d0f4))
* **app:** UI foundation on shadcn and Base UI ([#253](https://github.com/aaronbruiz/saas-foundation/issues/253)) ([db32773](https://github.com/aaronbruiz/saas-foundation/commit/db327736be0f0ad7e3d36696996f3653ce39c46c))
* **organizations:** members page with pending invitations and revoke ([#220](https://github.com/aaronbruiz/saas-foundation/issues/220)) ([2a3167a](https://github.com/aaronbruiz/saas-foundation/commit/2a3167a54b53ac54cb6d56ebf1e1a6be27ad7f9d))
* **organizations:** remove members and change their role ([#225](https://github.com/aaronbruiz/saas-foundation/issues/225)) ([dac507d](https://github.com/aaronbruiz/saas-foundation/commit/dac507d67994fab501b4923f8da3b0d83ddd0c4c))
* **organizations:** settings, leave, ownership transfer and delete ([#232](https://github.com/aaronbruiz/saas-foundation/issues/232)) ([3b90eb3](https://github.com/aaronbruiz/saas-foundation/commit/3b90eb37db36d6e42eaa00e4f47b4d2d8602d195))


### Bug Fixes

* **app:** form-level alerts for failures that are not about the typed value ([#278](https://github.com/aaronbruiz/saas-foundation/issues/278)) ([2329cd4](https://github.com/aaronbruiz/saas-foundation/commit/2329cd4a6fa07544c0ab0376e4491d1cb687d062))
* **app:** form-level invite errors and a stacked subprocessors list on phones ([#270](https://github.com/aaronbruiz/saas-foundation/issues/270)) ([5deb068](https://github.com/aaronbruiz/saas-foundation/commit/5deb068ccead6097a722410cb2525dd110a80a4c))
* **app:** security headers and a nonce-based CSP on every app response ([#243](https://github.com/aaronbruiz/saas-foundation/issues/243)) ([007c4ed](https://github.com/aaronbruiz/saas-foundation/commit/007c4edb8ef5236e715fb8c101f4ac2eeea4236d))
* **ci:** install Playwright's Chromium without apt ([#266](https://github.com/aaronbruiz/saas-foundation/issues/266)) ([34450e8](https://github.com/aaronbruiz/saas-foundation/commit/34450e8c716a5dd9acfdb73b602a345b8aa4858b))
* **db:** answer every request when its database backend is lost ([#210](https://github.com/aaronbruiz/saas-foundation/issues/210)) ([354525e](https://github.com/aaronbruiz/saas-foundation/commit/354525e5f8c7693da98bd9447c983f66d6d31468))
* **db:** stop waiting to close a connection whose socket has failed ([#223](https://github.com/aaronbruiz/saas-foundation/issues/223)) ([17c5509](https://github.com/aaronbruiz/saas-foundation/commit/17c5509e06a94d786584aad3b4495a7cb4cddf76))
* **deps:** bump the production-minor-and-patch group across 1 directory with 2 updates ([#256](https://github.com/aaronbruiz/saas-foundation/issues/256)) ([06d6a33](https://github.com/aaronbruiz/saas-foundation/commit/06d6a337b488ffe06d3f44c1c4e08678a8505591))
* **deps:** patch transitive seroval, zod, undici and tooling advisories ([#244](https://github.com/aaronbruiz/saas-foundation/issues/244)) ([a3517e1](https://github.com/aaronbruiz/saas-foundation/commit/a3517e1a717e85205845020eadbd42f962afdfbb))
* **deps:** update better-auth and its CLI to 1.7.17 ([#242](https://github.com/aaronbruiz/saas-foundation/issues/242)) ([11a488a](https://github.com/aaronbruiz/saas-foundation/commit/11a488a783745abd8332f631b4cada47cfe35cc7))


### Refactoring

* **app:** one shared layout for the auth pages ([#265](https://github.com/aaronbruiz/saas-foundation/issues/265)) ([67304a6](https://github.com/aaronbruiz/saas-foundation/commit/67304a6dd39aac16b808c193b9aec65e57d47902))

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
