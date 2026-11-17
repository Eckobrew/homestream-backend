# API & Contract Generation

HomeStream Backend is the source of truth for the public API contract (`src/api-schema.ts` and `src/types/index.ts`).

## Generating & Checking Contracts

```bash
npm run contract:generate   # Generates contract/openapi.json, models.ts, paths.d.ts
npm run contract:kotlin     # Generates contract/kotlin models & client operations
npm run contract:check      # Verifies contract is current and version-consistent
npm run contract:test       # Ensures no breaking removals without major version bump
```

To sync the TypeScript contract to `homestream-web`:

```bash
cp contract/openapi.json contract/models.ts contract/paths.d.ts ../homestream-web/src/api/
```
