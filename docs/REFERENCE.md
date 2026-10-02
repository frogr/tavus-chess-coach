# Coach Rook reference

Everything about how Coach Rook is built and run: configuration, architecture, the coach's tools, each mode, the HTTP API and the design decisions. The short version is the [README](../README.md).

## Contents

- [Run it](#run-it)
- [Configuration](#configuration)
- [Deploy](#deploy)
- [Pages and URL flags](#pages-and-url-flags)
- [Architecture](#architecture)
- [The coach's tools](#the-coachs-tools)
- [Coaches](#coaches)
- [Puzzles](#puzzles)
- [Playing the coach](#playing-the-coach)
- [Game review](#game-review)
- [The game screen](#the-game-screen)
- [Memory](#memory)
- [Audit log and admin dashboard](#audit-log-and-admin-dashboard)
- [HTTP API](#http-api)
- [Design decisions](#design-decisions)
- [Tests and CI](#tests-and-ci)
- [Known limits](#known-limits)
- [What I'd do next](#what-id-do-next)
- [Files](#files)
- [Licenses](#licenses)

## Run it

Needs Node 20 or later (`.node-version` pins 22).

```
npm install
cp .env.example .env        # add TAVUS_API_KEY
npm run setup               # registers 11 tools and one PAL per coach, writes .tavus.json
npm start                   # http://localhost:3000
npm test                    # Tavus is faked: no key or minutes needed
```

Without `TAVUS_API_KEY` the board, puzzles, games and review all still work; only the video coach is off. `npm run setup` is optional: the server runs the same setup on boot when a coach is missing.

## Configuration

Set these in `.env` locally or in the host's environment.

| Variable | Default | What it does |
|---|---|---|
| `TAVUS_API_KEY` | none | Turns on the video coach. Stays on the server. |
| `ACCESS_CODE` | none | If set, starting a video session (and reading memory) needs this code. Use it on any public URL: sessions spend Tavus minutes. |
| `DATABASE_URL` | none | Postgres connection string for the audit log and the student ledger. Without it both are held in memory and lost on restart, which for the ledger means memory cannot be rebuilt. Set it in production. |
| `ADMIN_TOKEN` | none | Turns on `/admin`. Use a long random value. |
| `MAX_CALL_SECONDS` | `3600` | Longest a video session may run. 3600 is Tavus's ceiling. |
| `TAVUS_LLM_MODEL` | `tavus-gpt-4.1` | The language model behind every coach. Tavus's default model did not call tools reliably (see Design decisions). |
| `AUDIT_RETENTION_DAYS` | `0` | Days of audit events to keep. `0` keeps everything. |
| `PORT` | `3000` | Port to listen on. |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | The server's public address, so Tavus can send callbacks (transcript, shutdown reason). |
| `TAVUS_PAL_ID` | none | Use an existing PAL for the first coach instead of finding or creating one. |
| `TAVUS_FACE_ID` | `rc9cff32ceba` | Face for the first coach. |
| `AUTO_SETUP` | on | Set to `0` to stop the server registering PALs and tools on boot. |
| `LIMIT_API_PER_MIN` | `300` | Requests per client per minute, all routes. |
| `LIMIT_ENGINE_PER_MIN` | `60` | Engine requests per client per minute. |
| `LIMIT_REVIEW_PER_MIN` | `6` | Game reviews per client per minute. |
| `LIMIT_EVENT_POSTS_PER_MIN` | `120` | Browser event reports per client per minute. |
| `ENGINE_MOVETIME` | `1500` | Default time cap per engine search, in ms. |
| `ENGINE_MAX_WAITING` | `60` | Engine queue length before the server answers "busy". |
| `ENGINE_WATCHDOG_GRACE` | `20000` | How far past its budget a search may run before the engine is restarted, in ms. |

`LIMIT_SESSIONS_PER_10MIN` and `LIMIT_BAD_CODES_PER_10MIN` (10 each) cap session starts and wrong access codes per client.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/frogr/tavus-chess-coach)

Render reads `render.yaml` and asks for `TAVUS_API_KEY`, `ACCESS_CODE`, `DATABASE_URL` and `ADMIN_TOKEN`. On first boot the server registers the tools and the four PALs itself. Free instances sleep when idle, so the first load after a quiet spell takes about 30 seconds.

`render.yaml` sets `autoDeployTrigger: checksPass`, so once the repo is connected to Render through its GitHub integration, a push to `main` goes live only after CI passes. Until then, deploy by hand:

```
render deploys create <service-id> --confirm
curl https://<your-app>/healthz        # reports the commit that is live
```

## Pages and URL flags

| Path | What it is |
|---|---|
| `/` | The app. |
| `/about` | The marketing page. |
| `/admin` | The audit dashboard. |
| `/healthz` | Liveness, and the deployed commit. |

| Flag on `/` | What it does |
|---|---|
| `?debug` | Adds a live log drawer of tool calls and board events. |
| `?sim=1` | Adds buttons to that drawer that fire fake tool calls through the real handlers, without spending conversation minutes. |
| `?typed` | Exposes `studentSays('…')` in the console: a typed line reaches the coach as a spoken one would. Used to record and test calls from a script. |
| `?nomedia` | Joins a call without the microphone or camera. |

## Architecture

```
 Browser                                               Tavus CVI
┌────────────────────────────────────────┐          ┌──────────────────────┐
│  Board (chess.js)  ── source of truth   │          │  One PAL per coach   │
│        │                                │  app     │  Raven-1 perception   │
│        ├─ student moves ──► respond ────┼─message─►│  Sparrow-2 (patient)  │
│        ├─ quiet moves ──► append_context│  (Daily) │  LLM + 11 tools        │
│        │                                │          │  memory per student   │
│  Tool handlers ◄─── conversation.tool_call ────────┤                      │
│        │        ───► conversation.tool_result ────►│                      │
│  Daily call object (video)              │          └──────────────────────┘
└────────┬───────────────────────────────┘
         │ /api/analyze, /api/play, /api/review, /api/session …
┌────────▼───────────────────────────────┐
│  Node server (no framework)            │──► tavusapi.com/v2 (API key stays here)
│   Stockfish in a child process         │──► Postgres (audit log)
│   positions and lines in plain English │
│   puzzle pool, review, move choice     │
└────────────────────────────────────────┘
```

Traffic runs in two directions, both over the Tavus interaction protocol:

1. **Board to coach.** What happens on the board is sent to the PAL tagged `[board]`, already annotated with ground truth: whether a move was correct, what the engine says it allowed, what the opponent replied. Events the coach should react to out loud go as `conversation.respond`. Events it only needs to know go as `conversation.append_llm_context`. A puzzle's solution is included and marked for the coach only, so hints are graded instead of guessed.
2. **Coach to board.** Eleven tools, delivered to the browser as app messages and handled there.

## The coach's tools

| Tool | What it does | `on_call` / `on_resolve` | Why |
|---|---|---|---|
| `chess_analyze_position` | Stockfish on the current board, optionally comparing a move the student asked about | `static_filler` / `generate_response` | The engine takes about a second; a fixed "let me check that with the engine" covers it and is true |
| `chess_show_on_board` | Highlights squares and draws arrows on the student's board | `generate_filler` / `add_to_context` | The generated filler is the explanation, spoken while the highlight appears |
| `chess_load_puzzle` | next / retry / easier / harder / a named theme | `silent` / `generate_response` | The coach introduces the new puzzle from the description it gets back |
| `chess_play_solution` | Animates the full answer | `silent` / `generate_response` | Only when the student gives up |
| `chess_goto_moment` | Review: jumps to key moment N, the position before the mistake, and lets the student try again | `silent` / `generate_response` | The coach drives the pacing; the board does the bookkeeping |
| `chess_show_engine_line` | Animates the engine's line, then returns to the position | `static_filler` / `generate_response` | "Watch this" while the pieces move, then the coach explains |
| `chess_new_game` | Starts a game against the coach at a strength and color | `silent` / `generate_response` | "Play me, but go easy" works by voice |
| `chess_take_back` | Undoes the student's last move and the coach's answer | `silent` / `generate_response` | Only when the student asks; the coach never offers one |
| `chess_review_game` | Opens a game in review: the one from this call, else the newest saved game; `game=N` picks a saved game, `chesscom_username` loads from chess.com | `static_filler` / `generate_response` | The engine pass takes a few seconds |
| `chess_goto_move` | In review, puts the board on a given move | `silent` / `generate_response` | "Go to move 12" |
| `chess_open` | Switches the screen back to the puzzle, the game or the review already open | `silent` / `generate_response` | Moving around without loading anything new |

The coach drives the app: the prompt tells it to call a tool for any request to switch, never to send the student to a tab. When a call starts, and whenever the student switches tabs themselves, the board tells the coach what is on screen and which saved games exist. Games against a coach are saved after every move, in the browser and on the server, so a game from an earlier call, finished or not, can be reviewed in the next one.

The definitions and the system prompt are in `server/pal-config.js`.

## Coaches

`server/coaches.js` lists four coaches: Anna (patient, asks before she tells), Victor (veteran club coach), Helen (exacting, makes you calculate) and Darius (energetic, loves tactics). Each is its own PAL with a stock Tavus face and voice and a paragraph of personality. The tools and the rules about checking chess with the engine are shared.

Setup creates or updates one PAL per coach, finding each by name so restarts never create duplicates. The lobby shows a picker once the PALs exist. Session notes are pinned to every coach's memory store, so switching coach keeps the history. The first coach keeps the original PAL.

A session runs for up to `MAX_CALL_SECONDS`. The time left is shown in the call bar.

## Puzzles

- **The pool.** About 4,800 puzzles from the Lichess puzzle database (CC0), filed under 20 themes and three levels by rating. `scripts/import-puzzles.js` builds it.
- **Checked against our engine.** A puzzle is kept only if Stockfish, at the strength this server runs it, also picks the solution's first move (4,830 of 4,858 candidates passed). `npm run verify-puzzles` re-checks a random sample in CI.
- **Selection.** Each request picks a new theme, skips puzzles this browser has seen, and takes the level from the student's puzzle rating. The theme stays hidden until the puzzle is solved. The coach can ask for easier, harder, or a theme by name.
- **Rating.** Each puzzle is scored like a rated game against the puzzle's Lichess rating (Elo, K = 40): a clean solve is a win, a solve with wrong tries or hints a draw, giving up a loss. The rating and streak are kept in the browser and reported to the coach.

## Playing the coach

- **Strength.** `server/play.js` weakens Stockfish the way Lichess and chess.com levels do: a shallower search, then a weighted pick among the engine's top candidates, where worse moves get more weight as the rating drops. At 500 and 1000 there is also a small chance of a move played without looking. 3000 is the engine's best move. The ratings are labels for these settings, not measured Elo.
- **One request per move.** `POST /api/play` judges the student's move with the same win-chance scoring the review uses, answers it, and returns the position in words.
- **The coach hears every move but speaks on few.** Each move goes to the PAL as silent context with the engine's verdict. It is asked to speak when the student blunders (or makes a mistake, below 2500), after a run of quiet moves, and when the game ends.
- **Attitude follows strength.** The message that starts a game tells the coach how to behave: easygoing and talkative at 500, competing and saying little at 3000. The coach is told the engine's lines in neutral words and asked for ideas (what a move left open, what the stronger plan was after), never grades or take-back offers. Questions get an engine-checked answer at every strength.

## Game review

1. `POST /api/review` loads the PGN (or downloads it from Lichess's export API) and runs Stockfish over every position in two passes: a fast scan, then a deeper re-check around every move the scan flagged. Results are cached.
2. Each move is scored by **lost winning chances**, using Lichess's win-probability curve and not raw centipawns. Going from +9 to +6 is still winning and isn't flagged; going from +1 to -2 is. Losses of 10, 20 and 30 points become inaccuracy, mistake and blunder.
3. The student's four costliest moves become **key moments**, each described in plain English: what was played, the evaluation before and after, the engine's preferred move and line.
4. The coach gets a compact summary. Interaction messages are capped at 4 KB, so it carries the key moments and not the whole game.
5. When the student tries a move at a key moment, `POST /api/judge` accepts anything that keeps nearly all the winning chances of the engine's best (within 5 points), since real positions rarely have only one good move.

Games longer than 400 half-moves are refused.

## The game screen

Review and play share the parts of a chess site's game view, in `public/gameview.js`: a two-column move list with mistake badges, an evaluation timeline you can click to jump through the game, an evaluation bar, player lines with accuracy, autoplay, flip, and keyboard navigation (arrows, Home, End, Space, F).

During a game against the coach only the move list shows, since the evaluation would give the game away.

The Review tab lists games to load: the ones played against the coach (saved in the browser and on the server) and a chess.com player's recent games, fetched in the browser from chess.com's public archives.

## Memory

Full description, guarantees and limits: [docs/MEMORY.md](MEMORY.md).

Three layers:

- **The ledger.** Every session a student finishes is written to Postgres (`student_sessions`) and kept forever. It records what happened on the board: what was solved first try, what took wrong tries or hints (and which moves), what was given up on, reviewed games, games against the coach. This is the source of truth.
- **Pinned memories (Tavus).** What the coach reads. Rebuilt from the ledger: one **Student profile** note with lifetime totals and recent strengths and weaknesses, plus the 12 most recent **Session notes**. A sync compares what should be pinned with what is, repairs the difference and reads it back. It runs at the end of every session for all four coaches and at the start of every session for the chosen coach, so a write that failed is repaired before the next call.
- **Learned memory (Tavus).** Tavus maintains it from each conversation (goals mentioned, how the student likes to be coached). The app does not control or verify it.

During a call the browser checkpoints the session to the ledger every 20 seconds, so a closed laptop does not lose the note. At the next session the profile and the latest notes go into the conversation context and the greeting is generated from them. The **Notebook** panel shows what is pinned.

A student is their name plus a random **notebook key** generated in their browser, so someone else typing the same name gets an empty notebook. The key is shown in the notebook panel so it can be carried to another device. What the browser reports is filtered down to known themes, real chess moves and fixed result words before it is stored.

## Audit log and admin dashboard

Every input and output is recorded on the server; [docs/OBSERVABILITY.md](OBSERVABILITY.md) lists each one and where to find it. To debug what the coach said, you need what it was told:

- **Every API request** to this server: method, path, status, timing, request and response.
- **Every call to Tavus**, with request and response, and **every Tavus callback** (transcript, perception analysis, shutdown reason). After a call ends the server also pulls Tavus's own record of the conversation.
- **Everything the browser saw**: each move, puzzle, game and review; every message the board sent to the coach; every interaction event that came back (utterances as they stream, tool calls and results); call lifecycle and errors. The browser batches these and retries a report that fails.

Events are tied together by conversation ID and by a per-page-load visit ID. Secrets (the access code, notebook keys, tokens) are redacted before anything is written.

`/admin` shows sessions (transcript, tool calls, what the coach was sent, the full timeline), visits, and a searchable stream of all events. A session's transcript can be read from two sources: what the browser reported, and Tavus's own transcript. Video is not recorded: Tavus records only to an S3 bucket you provide.

## HTTP API

All bodies are JSON. Errors are `{ "error": "…" }` with a 4xx status for bad input and 503 when the engine is busy.

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness and deployed commit. |
| `GET /api/config` | Whether the coach is on, whether a code is needed, and the coaches available. |
| `POST /api/puzzle` | A puzzle by level, optionally by theme, avoiding ones already seen. |
| `POST /api/describe` | A position in words. |
| `POST /api/analyze` | The engine's view of a position, optionally judging a candidate move. |
| `POST /api/play` | One turn of a game: judges the student's move and answers it at a strength. |
| `POST /api/review` | Reviews a game from a PGN or a Lichess link. |
| `POST /api/judge` | Judges a try at a key moment. |
| `POST /api/session` | Starts a video session. Needs the access code. |
| `POST /api/session/checkpoint` | Stores the session so far in the ledger. Needs the access code. |
| `POST /api/session/end` | Ends it, stores the session and syncs every coach's memory. Needs the access code. |
| `POST /api/game` | Stores a game against a coach (called after every move). |
| `POST /api/games` | The games stored for this browser key. |
| `POST /api/memory` | A student's notebook. Needs the access code. |
| `POST /api/events` | Browser event reports for the audit log. |
| `POST /api/tavus/webhook/<token>` | Tavus callbacks. |
| `GET /api/admin/overview`, `/session`, `/events` | The dashboard's data. Needs the admin token. |

## Design decisions

- **The model never does chess.** It asks, explains, encourages and points. Correctness comes from the board (move validation) and Stockfish (evaluation). The system prompt says so, and the tools make the right path the easy one.
- **No FEN or UCI reaches the LLM.** LLMs misread FEN. The server turns positions into "White: king on g1; rook on d1…" and engine lines into "knight from e4 to d6, with check; White is completely winning (+7.6)".
- **Turn-taking tuned for thinking.** Chess means long silences. `turn_taking_patience: high` stops the coach from jumping in while the student calculates, and `idle_engagement: patient` gives a nudge, not an answer, when they go quiet.
- **Memory is written from the board, and the app keeps its own copy.** The ledger is permanent; Tavus's pinned notes are rebuilt from it and verified after every write. Tavus's learned memory adds the softer context.
- **The model is chosen for tool calling.** The coach runs the app through tools, so a model that says "starting a game" without calling the tool breaks the product. On the same four requests in a live call, Tavus's default model made one tool call of four; `tavus-gpt-4.1` made all four. Every coach uses it.
- **STT hotwords** for chess vocabulary ("Nf3", "en passant", "skewer"), which general speech-to-text mangles.
- **The key stays on the server.** The browser only gets a `conversation_url`.
- **Setup is code.** `npm run setup` is idempotent: tools are matched by name and patched, each PAL is found by ID or name and patched in place. A fresh deploy configures itself on boot.
- **Public endpoints are bounded.** Every engine route is rate limited per client, the engine queue and game length are capped, and wrong access codes lock a client out after ten tries. A bad FEN or PGN is a 400, never a crash.
- **The engine runs in its own process.** A search that hangs is killed and the engine replaced, without taking the server with it.
- **Dependencies are pinned and self-hosted.** chess.js and the Daily SDK are served from the installed npm packages; piece images live in the repo. The Content-Security-Policy allows Daily's call engine (`'unsafe-eval'` plus `c.daily.co`), Google Fonts, and chess.com's public API, and nothing else from outside.
- **A custom call UI.** The call runs on a Daily call object and the page renders the coach's video itself: the coach, captions and three controls.
- **The page stays quiet.** No instructions or commentary on screen. Talking is the coach's job.

## Tests and CI

`npm test` runs 90 tests with `node:test`: the engine wrapper, review scoring, move choice at each strength, puzzle selection, memory (sanitizing, the profile, sync and repair, a 10,000-session run), the HTTP surface, and the Tavus-facing flows (boot setup, sessions, memory, audit) against a fake Tavus API in `test/helpers.js`. CI (`.github/workflows/ci.yml`) runs them plus `npm run verify-puzzles` on every push.

There are no browser tests. The UI is checked by hand and with the `?sim=1` simulator.

## Known limits

- **Strength ratings are labels.** They name engine settings and have not been measured against rated players.
- **A coach move takes a few seconds** on Render's free tier, and the instance sleeps when idle.
- **Puzzle rating, streak and seen puzzles live in the browser.** They do not follow a student across devices. Session notes and games against a coach do, with the notebook key.
- **A notebook key is not an account.** Anyone with the name and key can read and add to that notebook. Lose the key and the notebook starts empty (the history stays in the ledger; see docs/MEMORY.md, Repairs).
- **Tavus's learned memory is not verified.** Only the board-written notes are. See docs/MEMORY.md, What is not guaranteed.
- **One access code for everyone.** There are no per-user credentials or quotas.
- **Sessions end at an hour**, Tavus's ceiling.
- **chess.com games are fetched by username only**, from the last two monthly archives.

## What I'd do next

- **Perception tool:** a Raven visual query for "the student looks stuck" that triggers an earlier hint.
- **Spaced repetition from memory:** bring a missed theme back two sessions later and track each theme's hit rate.
- **Voice moves:** "knight to d6" spoken, parsed and played on the board.
- **Measured strengths:** play the levels against rated engines and relabel them.
- **Real accounts:** key memory, rating and game history to a signed-in user.
- **Openings and clocks in review:** opening names, book moves and time spent per move.

## Files

```
server/index.js          HTTP server: routes, static files, security headers, rate limits, PAL bootstrapping
server/engine.js         Stockfish wrapper: child process (engine-worker.js), serialized queue, watchdog
server/chessText.js      positions and engine lines -> plain English
server/pal-config.js     system prompt, greeting, tool definitions
server/coaches.js        the four coaches: face, PAL name, personality
server/setup.js          idempotent Tavus setup (tools, one PAL per coach); also runs on boot
server/tavus.js          Tavus API client; every call is recorded in the audit log
server/puzzles.js        puzzle selection: theme, level, no repeats
server/themes.js         the 20 tactical patterns
server/puzzle-pool.json  ~4,800 puzzles from the Lichess database, verified against our engine
server/play.js           playing the coach: strength levels, move choice, one turn of a game
server/review.js         game review: engine passes, mistake scoring, key moments, judging a try
server/memory.js         student memory: session notes, the profile, syncing Tavus from the ledger
server/ledger.js         the permanent record of every student session (Postgres or in-memory)
server/audit.js          audit log: Postgres or in-memory store, redaction, batching
server/limits.js         per-client rate limits
server/env.js            .env loader
server/errors.js         HTTP errors safe to show a client
scripts/import-puzzles.js   rebuilds the pool from the Lichess database
scripts/verify-puzzles.js   re-checks a random sample of the pool
scripts/backfill-ledger.js  copies pre-ledger sessions from the audit log into the ledger
docs/MEMORY.md           how memory works, what is guaranteed, how to check it
docs/OBSERVABILITY.md    every input and output, where it is recorded, how to look it up
public/index.html, styles.css, app.js   the app: modes, tool handlers, interaction protocol, the call
public/board.js          board renderer: sliding pieces, drag and click moves, arrows, badges
public/gameview.js       move list, evaluation timeline, evaluation bar, player lines
public/sounds.js         synthesized move sounds (WebAudio, no audio files)
public/admin.*           the admin dashboard
public/about.*           the marketing page
public/ad.mp4, live-call.mp4   the ad and a recorded call, shown on the marketing page
public/coaches/          coach thumbnails
public/pieces/           piece images (cburnett set, see LICENSE.txt there)
public/samples/          two sample games for review
test/                    node:test suites; helpers.js has the fake Tavus API
render.yaml              Render deploy
.github/workflows/ci.yml CI
```

## Licenses

The code in this repo is MIT. It runs [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL) as an npm dependency on the server. The piece images in `public/pieces/` are by Colin M.L. Burnett (GPLv2+). The puzzles in `server/puzzle-pool.json` are from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0). The coach faces are Tavus stock replicas.
