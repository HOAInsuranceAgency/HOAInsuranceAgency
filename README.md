# HOA Insurance Agency

Monorepo for HOA Insurance Agency ([protectmyhoa.com](https://www.protectmyhoa.com)).

| App | Path | Stack | Amplify app |
| --- | --- | --- | --- |
| Marketing site | [`web/`](web) | Astro (static) + React islands | Web (no backend) |
| CRM | [`crm/`](crm) | Vite + React SPA, Amplify Gen 2 (Cognito, AppSync/DynamoDB, S3, Lambda/Textract) | CRM (full-stack) |

Both apps deploy from this repo as separate AWS Amplify apps using the
monorepo build spec in [`amplify.yml`](amplify.yml). Each Amplify app sets
`AMPLIFY_MONOREPO_APP_ROOT` to `web` or `crm`.

## Branches

- `main` — production
- `staging` — pre-production; both Amplify apps build this branch. Land work
  here first, verify on the staging URLs, then merge to `main`.

## Development

```sh
# Marketing site
cd web && npm install && npm run dev

# CRM (frontend + a personal cloud sandbox backend)
cd crm && npm install
npx ampx sandbox        # deploys an isolated dev backend, writes amplify_outputs.json
npm run dev             # in a second terminal
```

See [`crm/README.md`](crm/README.md) for CRM architecture and data model notes.
