# Geography Bee

Spaced repetition for the 195 UN member states — where they are, what they are
next to, and enough context to make the location stick.

A static PWA. No backend, no accounts, no network calls at build or runtime.
Progress lives in this browser's localStorage.

## Why it is built this way

**Pointing at a country is a different skill from naming one.** Most geography
apps only test recognition — here's a shape, name it. Being given "Paraguay" and
having to find it on a map is the harder and more useful direction, so `locate`
and `identify` are separate cards with separate scheduling state.

**Your wrong answers are the most valuable data in the app.** When you click
Slovenia instead of Slovakia, that is recorded as a confusion pair. A flashcard
app that stores only right/wrong throws that away; here it feeds multiple-choice
distractors and, later, targeted discrimination drills.

**Grades are never asked for.** Self-rating is the biggest source of noise in
spaced repetition, and this interaction already knows the answer: a wrong pick
is Again, recovery after a wrong pick is Hard, hesitation past a per-card-type
threshold is Hard, and fast unassisted recall is Easy. Multiple choice is capped
at Good, because picking from four options is not the same act as producing the
answer cold.

**Facts are shown, not tested — at first.** After every answer the reveal panel
shows the country with its neighbours labelled, plus context. Their job early on
is to give the shape a story, not to be recalled.

**Rapid review is the sprint lane.** A tap-only run over countries already
met: no teach screens, no reveal panel, just prompt → tap → a sub-second flash
of the answer → next. One attempt per card. Every answer still lands in the
scheduler, the review log, and the confusion matrix — only the ceremony is
removed. Due cards come first, then the weakest recall.

**Wrong answers become drills.** Every wrong map click is logged as a confusion
pair. Once a pair recurs, a confusion round runs after the session: both
candidates marked, tap the named one, then the mirror question. A correct
discrimination decays the pair's count and a wrong one feeds it, so a pair is
drilled exactly until it stops being confused — no extra scheduling state.

**The daily cap has an explicit escape hatch.** New material is budgeted per
day, which means a pack started after today's budget is spent enqueues nothing
until tomorrow — correct, but it reads as a bug. A "+5 new cards today" button
grants extra budget for today only: it stacks within the day, never leaks into
tomorrow, and only appears when pressing it would actually surface cards.

**Extra material is opt-in, through packs.** The world tour (locate + identify)
is on by default. Skill packs — Capitals, Flags, Borders — add a new kind of
question, and generate cards per country only once its two map cards are
established, so day three is not a wall. Region spotlights pull one region into
the rotation ahead of the world tour. Pausing a pack stops new introductions
but never touches the review schedule of existing cards: a card owes its
reviews to the forgetting curve, not to the pack that spawned it.

## Running it

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # 51 unit tests
npm run typecheck
npm run build          # production build into dist/
```

Browser smoke tests need a server already running:

```bash
npm run smoke:cards    # asserts every card type shows its matching control
npm run smoke:session  # drives a full study session and reloads
```

Both accept `SMOKE_URL` (default `http://localhost:5173`) and `SMOKE_OUT` for
screenshots.

## Data

`npm run build:data` regenerates everything under `public/data/` from npm-vendored
sources and commits it as reviewable JSON. It is **not** run at deploy time —
Vercel only runs `vite build` over the committed files.

See [ATTRIBUTION-DATA.md](./ATTRIBUTION-DATA.md) for sources, licensing, and the
upstream data defects the pipeline works around.

Hooks are the one authored dataset. They live in `hooks/<region>.json` — one
file per quiz region, so edits stay scoped to the part of the world you are
working on — and `npm run build:hooks` merges them into `public/data/hooks.json`
after checking that every ISO code is real, filed under the right region, and
not duplicated. `build:data` runs the merge too, so region changes and hooks
cannot drift apart.

## Deployment

Vercel runs `vite build` over the committed files — the data pipeline never runs
at deploy time.

Two things in `vercel.json` are deliberate:

- **`/data/*` is revalidated, not cached immutably.** Those files keep stable
  paths across builds, so an immutable header would leave anyone holding a
  cached copy unable to see regenerated data. Offline support comes from the
  service worker, which versions its own precache.
- **`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.** Vercel installs devDependencies to
  build, and `playwright` otherwise downloads ~150MB of Chromium during install
  for smoke tests that never run there.

Note that `vercel.json` is schema-validated strictly and rejects any unknown
property — including a `comment` key inside a header entry, which fails the
deploy before it reaches the build step. Keep explanations here instead.

## Layout

```
scripts/build-data.ts   data pipeline (run locally, output committed)
src/map/                d3-geo rendering, projection fitting, click snapping
src/srs/                card model, behaviour-derived grading, FSRS wrapper
src/store/              chunked localStorage, capped review log, aggregates
src/session/            session composition, answer matching, packs, drills
src/stats/              mastery, pacing, and time-to-mastery projections
src/ui/                 study loop, reveal panel, home
```

## Storage

Card state is bounded — 195 countries × 5 card types is about 200KB — so
localStorage is a comfortable fit. Only the raw review log grows without bound
(~4MB/year), so it is capped at a rolling 5,000 rows. The one consumer that
needs row-level history is FSRS parameter optimisation, which wants roughly a
thousand; everything else reads aggregates that are updated on write and never
pruned.

Progress lives only in this browser. Clearing site data erases it, and iOS
evicts storage for PWAs that are not installed to the home screen after 7 idle
days — so export/import is built in, and the home screen nags after 30 days
without a backup.

## Status

Milestones 1–4 are done, all 195 countries have written hooks, and packs,
confusion drills, and the progress dashboard (mastery choropleth + region ETAs)
are in. Still to come: FSRS parameter fitting against your own review history.
