# Community + Discussions setup (one-time)

This doc walks through the **two** one-time configuration steps the
maintainer needs to do once, after which the giscus widget on blog/doc
pages and the live `/community` page will pull data automatically on every
deploy.

## 1. giscus inline-comments — one-time

We added a `<Giscus />` component that drops onto the bottom of every
blog post, doc page, and `/whats-new` page. Until two IDs are filled in,
the component renders a polite placeholder that links out to GitHub
Discussions instead of the live widget. The placeholder build will work
fine — the widget will just be inert.

To turn the widget on:

1. Visit https://giscus.app
2. Under **Repository** enter: `zhitongblog/solomd`
   - giscus will verify the repo is public, has Discussions enabled, and
     the `giscus` GitHub app is installed. If the app isn't installed
     yet, click **Install giscus** (the button on the giscus.app page).
3. Under **Page ↔ Discussions Mapping** pick:
   `Discussion title contains page pathname`
4. Under **Discussion Category** pick: `General`
   (we use a single bucket for all comments — keeps moderation simple).
5. Under **Features** keep defaults — reactions on, metadata off, input
   at the bottom, lazy-load on.
6. Under **Theme** pick `preferred_color_scheme`.

giscus.app then prints a `<script>` tag at the bottom. **Copy these two
values** out of that snippet:

```
data-repo-id="..."
data-category-id="..."
```

7. Paste them into `web/src/components/Giscus.astro`:

```ts
const GISCUS_REPO_ID = 'R_kgDO...';      // <- paste here
const GISCUS_CATEGORY_ID = 'DIC_kwDO...'; // <- paste here
```

8. Commit + redeploy. The widget will load on every blog/doc page next
   build.

That's it. No env vars, no secrets — both IDs are public.

## 2. /community page — GitHub GraphQL token

The `/community` page (and `/zh/community`) fetches the latest 20
discussions at **build time** via the GitHub GraphQL API. This needs a
`GITHUB_TOKEN` env var available at build time.

### 2a. Generate the token

1. https://github.com/settings/tokens?type=beta
2. New fine-grained token → **All repositories** (or just `zhitongblog/solomd`)
3. Permissions:
   - **Contents**: read-only
   - **Metadata**: read-only (auto-required)
   - **Discussions**: read-only
4. Copy the token.

### 2b. Add it to the Cloudflare Pages / Vercel build env

- **Cloudflare Pages** → project → Settings → Environment variables →
  Production: add `GITHUB_TOKEN` = `ghp_...` (Encrypted).
- **Vercel** → project → Settings → Environment Variables → add
  `GITHUB_TOKEN` to Production.

### 2c. Local preview

`pnpm build` will work without the token — the `/community` page will
just render the empty / "Loading discussions…" state. To preview the
real data locally:

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx pnpm --dir web build
```

Then `pnpm --dir web preview` and visit http://localhost:4321/community/.

## Notes & gotchas

- **Token rotation** — the token has read-only scopes and only touches
  one repo. Set its expiry to 1 year and rotate annually.
- **Build-time vs runtime** — the discussion list is baked into the
  HTML at deploy time. New threads appear on the next deploy. If you
  want sub-deploy freshness, make a Pages Function that proxies
  `api.github.com/graphql` and have the page fetch client-side instead.
  We deliberately chose build-time to keep the page zero-JS.
- **Categories** — the page hard-codes the canonical Discussions
  category names (Announcements / General / Ideas / Polls / Q&A / Show
  and tell). If you add or rename categories on GitHub, update the
  `CATEGORY_ORDER` array and the i18n `categoryNames` / `categoryEmoji`
  maps in `web/src/i18n/translations.ts`.
- **Disable per-page** — pass `enabled={false}` to `<Giscus />` to skip
  the widget on a specific page (e.g. legal pages). Default is on.
