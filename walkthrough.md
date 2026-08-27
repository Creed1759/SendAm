# Walkthrough

**PR Title**: feat(api): strictly enforce configured CORS origins across environments (#212)

## PR Description

### What
Enforces strict CORS validation in the API, explicitly rejecting malformed, null, and unapproved origins with observability metrics.

### Why
Closes #212
Cross-origin access previously relied on permissive defaults during development, and did not explicitly reject unapproved origins with structured logs and metrics. This enforces a secure-by-default policy across all environments.

### How
- Updated `app.js` to replace permissive environment-based fallbacks with a strict validation block using explicit origin checking.
- Updated `corsOptions` to handle `credentials: true` consistently.
- Added explicit rejection for `origin === 'null'` (which typically indicates a sandboxed iframe or a `file://` scheme bypass).
- Used a custom error handler middleware directly succeeding `cors()` to intercept CORS violations and return a 403 Forbidden response instead of 500 Server Error, while logging warning metrics for `null_origin` and `unapproved_origin`.
- Added a comprehensive integration test `test/cors.test.js` validating the origin checks and failure codes.

### Testing
- Validated via `node --test test/cors.test.js` covering explicitly allowed origins, unapproved origins, malformed/null origins, and non-browser clients (missing `Origin` header).
- Run full suite `npm run test` locally.

## Files Changed

| File | Description |
|------|-------------|
| `apps/api/src/app.js` | Updated CORS configuration to explicitly validate origins and reject with metrics and 403 responses instead of passing errors to the global 500 handler. |
| `apps/api/test/cors.test.js` | Added new test suite to explicitly verify CORS headers and status codes for production, development, and invalid origins. |

## CI Results
- **Typecheck**: N/A (no typescript)
- **Lint**: Passing
- **Test**: Passing
- **Build**: N/A
