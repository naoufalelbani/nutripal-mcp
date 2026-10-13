## NutriPal MCP v0.3.1

Food search now uses MyFitnessPal's Next.js data route with the required encoded search parameters. It no longer interprets a generic chart page as search results.

When a website session has expired but account API reads still work, search reports `MFP_SESSION_STALE` with the affected profile. This includes logout redirects embedded in an HTTP 200 Next.js response. Refresh the session with `auth --profile NAME`.

Search diagnostics now probe the same data route and report safe status metadata. Regression tests cover request parameters, redirects, and missing search data.
