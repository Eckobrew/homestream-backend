import js from '@eslint/js';
import ts from 'typescript-eslint';
// Start with new service modules; legacy handlers retain their existing baseline.
const files = ['src/state/**/*.ts','src/media/**/*.ts','src/api-schema.ts','src/upstream.ts'];
export default [
  { ignores: ['node_modules/**','dist/**','contract/**','tests/**','integration/**','scripts/**','tsup.config.ts','src/lib/**','src/services/**','src/app.ts','src/authenticate.ts','src/http.ts','src/identity.ts','src/log.ts','src/openapi.ts','src/public-api.ts','src/request-context.ts','src/routes.ts','src/server.ts','src/types/**'] },
  { files, languageOptions: { parser: ts.parser, ecmaVersion: 'latest', sourceType: 'module', globals: { process:'readonly',console:'readonly',setTimeout:'readonly',clearTimeout:'readonly',AbortSignal:'readonly',AbortController:'readonly',Request:'readonly',Response:'readonly',RequestInit:'readonly',URL:'readonly' } }, plugins:{ '@typescript-eslint':ts.plugin }, rules:{...js.configs.recommended.rules,...ts.configs.recommended.at(-1).rules,'no-undef':'off','no-unused-vars':'off','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]} },
];
