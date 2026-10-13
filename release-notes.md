# NutriPal MCP v0.3.1

## Food search fix

Food search now calls MyFitnessPal's Next.js data route:
`/_next/data/{buildId}/food/calorie-chart-nutrition-facts.json?params=[query,page]`.
NutriPal reads the current build ID from the public homepage, encodes the query and page as JSON in `params`, and retries once with a refreshed build ID if the data route returns 404.

The previous implementation requested chart pages with the query embedded in the path and looked for results in page markup. Those pages could return HTTP 200 without any search results. The tested `/api/services/foods` URLs are food lookup routes and returned 422 for search parameters; `/api/services/search/nutrition` returned 404. These responses did not establish a working food search endpoint.

## Session errors and diagnostics

MyFitnessPal can keep account and diary API access working after its website session expires. The search data route can then return HTTP 200 with a Next.js redirect to `/account/logout`. NutriPal now reports that response, as well as HTTP redirects, as `MFP_SESSION_STALE` with a profile-specific reauthentication hint. It does not report either response as an empty search result.

`diagnose` now probes the data route used by `search_food` and reports status, whether a food query was present, and a stale-session hint when applicable. It does not print cookie values or food/account details.

## Verification

- 22 regression tests passed, including the encoded request, HTTP redirect, embedded Next.js redirect, and missing search data cases.
- Typecheck, build, Node.js launcher handshake, npm pack dry run, and GitHub CI passed.
- The live account and diary reads passed. Live food search returned `MFP_SESSION_STALE` because the available default website session redirects to logout. A successful live search with a refreshed session remains unverified for this release.

## Upgrade note

If `search_food` reports `MFP_SESSION_STALE` while other account tools work, refresh the affected profile's website session with `nutripal-mcp auth --profile NAME`, then run `nutripal-mcp live-check --profile NAME`. The default profile can use plain `auth` and `live-check`.
