# SoloMD landing page

The official website at https://solomd.app

Built with [Astro 5](https://astro.build), zero JS by default, deploys to Cloudflare Pages.

## Local development

```bash
cd web
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # outputs to dist/
pnpm preview  # serve dist/ locally
```

## Routes

- `/` — English (default)
- `/zh/` — 中文

Translations live in `src/i18n/translations.ts`.

## Deploy: Cloudflare Pages

1. Go to https://dash.cloudflare.com → Workers & Pages → Create
2. Choose **Pages** → **Connect to Git**
3. Select repo `zhitongblog/solomd`
4. Build settings:
   - **Framework preset**: Astro
   - **Build command**: `cd web && pnpm install --frozen-lockfile && pnpm build`
   - **Build output directory**: `web/dist`
   - **Root directory**: leave empty (repo root)
5. Save and deploy
6. Custom domain: Pages → Custom domains → add `solomd.app`
   (DNS auto-configures because the domain is registered with Cloudflare)

## Updating

Push to `main` → Cloudflare Pages auto-rebuilds and deploys.

To update download links after a new SoloMD release, edit the `VERSION`
constant in `src/components/Download.astro`.
