# sbox SDK docs (`apps/web`)

## Architecture

- **`app/(home)`** — the marketing landing page (hero, capabilities, get-started).
- **`app/(docs)/[...slug]`** — renders `content/docs/**/*.mdx` with the Fumadocs
  notebook layout.
- **`content/docs`** — the docs themselves. `meta.json` files drive the sidebar
  order; `general/`, `adapters/`, `plugins/`, `ai/`, and `api/` are root folders
  (their own nav tabs).
- **`source.config.ts` + `lib/source.ts`** — the Fumadocs MDX source. Codegen
  runs via the `prebuild` / `predev` `fumadocs-mdx` step into `.source/`.
- **`mdx-components.tsx`** — wires `<AutoTypeTable>`, which renders option tables
  straight from the SDK's TypeScript source (e.g.
  `packages/sbox-sdk/src/memory/index.ts` → `MemoryOptions`), so docs never drift
  from the types.
- **`app/llms.mdx/[[...slug]]`** — serves each page as raw markdown; the
  `/:path*.md` rewrite makes every page available at `<url>.md` for agents.
- **`app/search/route.ts`** — Fumadocs static search.

## Develop

```bash
pnpm --filter web dev      # http://localhost:3000
pnpm --filter web build    # production build (runs fumadocs-mdx codegen first)
pnpm --filter web start    # serve the build
pnpm --filter web types    # tsc --noEmit
```

## Add a page

Drop an `.mdx` file under `content/docs/` with `title` + `description`
frontmatter, then add its slug to the relevant `meta.json`. To document option
types, point `<AutoTypeTable>` at the interface in the SDK source.
