# Coach Rook

A live video chess tutor built on Tavus CVI, with two modes:

- **Puzzles.** You solve tactics on a real board while a PAL watches every move, talks you through hints, **points at squares on your screen**, and checks every claim against Stockfish before making it.
- **Game review.** Paste one of your games (PGN or a Lichess link). Stockfish scores every move, picks out your biggest mistakes, and Coach Rook walks you through them one at a time: back to the position before the mistake, "what were you thinking here?", and a chance to find the better move yourself before it shows you the engine's line.

```
npm install
cp .env.example .env        # add TAVUS_API_KEY
npm run setup               # registers 6 tools + the PAL, writes .tavus.json
npm start                   # http://localhost:3000
npm test                    # unit + HTTP tests; Tavus is faked, no key or minutes needed
```

### Deploy it (free, ~5 minutes)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/frogr/tavus-chess-coach)

Render reads `render.yaml`, asks for `TAVUS_API_KEY` and an `ACCESS_CODE`, and boots the server, which registers the PAL and tools on first start. The access code matters on a public URL: every video session spends the account's Tavus minutes, so the board and engine are open to anyone, but starting the coach needs the code. Free instances sleep when idle, so the first load after a while takes ~30 seconds.

Deploys are gated on tests: `render.yaml` sets `autoDeployTrigger: checksPass`, so once the repo is connected to Render through the GitHub integration, a push to `main` goes live only after the CI workflow passes. Until it is connected, deploy by hand with `render deploys create <service-id>`.

URL flags: `?debug` adds a live log drawer of tool calls and board events; `?sim=1` adds buttons to that drawer that fire fake tool calls through the real handlers, without spending conversation minutes; `?nomedia` joins a call without the microphone or camera.

## Audit log and admin dashboard

To debug what the coach said, you need what it was told. Everything is recorded:

- **Every API request** to this server: method, path, status, timing, request and response.
- **Every call to Tavus**, with the request and response, and **every Tavus callback** (transcript, perception analysis, shutdown reason). After a call ends the server also pulls Tavus's own verbose record of the conversation.
- **Everything the browser saw**: each move, puzzle load, game review and try; every message the board sent to the coach; every interaction event that came back (utterances as they stream, tool calls and results, speaking and thinking state); call lifecycle and errors.

Events are tied together by conversation ID and by a per-page-load visit ID, so a session reads as one timeline. Secrets (the access code, notebook keys, tokens) are redacted before anything is written.

Set `DATABASE_URL` (Postgres; a free Neon database is plenty) so the log survives restarts, and `ADMIN_TOKEN` to turn on the dashboard at `/admin`: sessions (transcript, tool calls, what the coach was sent, Tavus's own record, full timeline), visits, and a searchable stream of all events. Events are kept for `AUDIT_RETENTION_DAYS` (default 90). Without `DATABASE_URL` events are held in memory only. Video recordings are not captured: Tavus only records to an S3 bucket you provide.

## Memory

Coach Rook uses Tavus Memory Stores in two layers:

- **Session notes (pinned memory).** When a session ends, the board writes one factual note to your memory store: what you solved first try, what took wrong tries or hints (and which moves you tried), what you gave up on, and the mistakes from any game you reviewed. These are ground truth from the board, not the model's impression of the call, and pinned memories reach the PAL from the very next conversation with no processing delay.
- **Learned memory.** Tavus maintains it automatically from each conversation (goals you mention, how you like to be coached).

Next session, the latest notes go into the conversation context and the greeting is generated from them, so Coach Rook opens with "Welcome back, Austin. Last time the knight fork took you two tries, want to start there?" and can load a puzzle on that exact theme. The **Notebook** panel shows what's in your memory store.

## Why chess

A coach waits while you think, asks instead of telling, and points at the board. Video does those; text chat doesn't. Chess also punishes an LLM that improvises, so most of the work here is deciding what the model is trusted with (talking) and what it isn't (chess), and building the plumbing that enforces it.

## Architecture

```
 Browser                                               Tavus CVI
┌────────────────────────────────────────┐          ┌──────────────────────┐
│  Board (chess.js)  ── source of truth   │          │  PAL "Coach Rook"    │
│        │                                │  app     │  Raven-1 perception   │
│        ├─ student moves ──► respond ────┼─message─►│  Sparrow-2 (patient)  │
│        ├─ puzzle loads ─► append_context│  (Daily) │  LLM + 6 tools        │
│        │                                │          │  memory per student   │
│  Tool handlers ◄─── conversation.tool_call ────────┤                      │
│        │        ───► conversation.tool_result ────►│                      │
│  Daily call object (video)              │          └──────────────────────┘
└────────┬───────────────────────────────┘
         │ /api/analyze, /api/session
┌────────▼───────────────────────────────┐
│  Node server                           │
│   Stockfish (WASM) + plain-English     │──► tavusapi.com/v2 (API key stays here)
│   puzzle pool (engine-verified)         │
└────────────────────────────────────────┘
```

**Two directions of traffic, both over the interaction protocol:**

1. **Board → PAL.** Every student move becomes a `conversation.respond` event tagged `[board]`, already annotated with ground truth: was it correct, what the opponent replied, and for wrong moves, what the engine says the move allowed. The PAL reacts as if it watched the move. Puzzle loads go in as `conversation.append_llm_context`, including the solution marked "for the coach only", so hints are graded instead of guessed.
2. **PAL → board.** Six tools with app-message delivery, handled in the browser:

| Tool | What it does | `on_call` / `on_resolve` | Why |
|---|---|---|---|
| `chess_analyze_position` | Stockfish on the current board, optionally comparing a move the student asked about | `static_filler` / `generate_response` | Engine takes ~1s; a fixed "let me check that with the engine" sounds natural and is honest about what's happening |
| `chess_show_on_board` | Highlights squares and draws arrows on the student's board | `generate_filler` / `add_to_context` | The generated filler *is* the explanation, spoken while the highlight appears. Nothing to say after, so the result just lands in context |
| `chess_load_puzzle` | next / retry / easier / harder / a named theme | `silent` / `generate_response` | The PAL introduces the new puzzle from the description it gets back |
| `chess_play_solution` | Animates the full answer | `silent` / `generate_response` | Only when the student gives up |
| `chess_goto_moment` | Review: jumps to key moment N, the position just before the student's mistake, and lets them try again | `silent` / `generate_response` | The PAL drives the review's pacing; the board does the bookkeeping |
| `chess_show_engine_line` | Animates the engine's better line, then returns to the position | `static_filler` / `generate_response` | "Watch this" while the pieces move, then the PAL explains the idea |

## Design decisions

- **The model never does chess.** It narrates, asks, encourages, and points. Correctness comes from the board (move validation) and Stockfish (evaluation). The system prompt says so explicitly, and the tools make the right path the easy one.
- **No FEN or UCI reaches the LLM.** LLMs misread FEN constantly. The server turns positions into "White: king on g1; rook on d1…" and engine lines into "knight from e4 to d6, with check; White is completely winning (+7.6)".
- **Puzzles are drawn fresh from a pool of about 4,800.** They come from the Lichess puzzle database (CC0), filed under 20 teaching themes and three levels by rating. Each request picks a new pattern, skips puzzles this browser has already seen, and difficulty follows the student: two clean solves in a row moves up a level, giving up or two wrong tries moves down. The theme stays hidden until the puzzle is solved.
- **Every puzzle is checked against our own engine.** The coach verifies claims with Stockfish at the strength this server runs it, so a puzzle is only kept if that engine also picks the solution's first move (`scripts/import-puzzles.js`; 4,830 of 4,858 candidates passed). `npm run verify-puzzles` spot-checks a random sample in CI.
- **Turn-taking tuned for thinking.** Chess means long silences. `turn_taking_patience: high` stops the coach from jumping in while you calculate, and `idle_engagement: patient` gives a gentle nudge rather than an answer when you go quiet.
- **Memory is written from the board, not inferred from the call.** Pinned session notes come from what actually happened on the board; Tavus learned memory adds the softer context. The memory store is keyed to the student's name plus a random **notebook key** generated in their browser, so someone else typing the same name gets an empty notebook, not theirs. The key is shown in the notebook panel so it can be carried to another device.
- **STT hotwords** for chess vocabulary ("Nf3", "en passant", "skewer"), which general STT mangles.
- **Key stays on the server.** The browser only ever gets a `conversation_url`.
- **Setup is code, not clicks.** `npm run setup` is idempotent: tools are matched by name and patched, the PAL is found by ID or name and patched in place. A customer can re-run it after every prompt change and diff the config in git, and a fresh deploy configures itself on boot.
- **Access code on public deploys.** The API key never leaves the server, but anyone with the URL could still start sessions on your account, so `ACCESS_CODE` gates the video coach.
- **Public endpoints are bounded.** The board and engine are open to anyone with the URL, so every engine route is rate limited per client, the engine queue and game length are capped, and wrong access codes lock that client out after ten tries. Inputs are validated (a bad FEN or PGN is a 400, never a crash), and what the browser reports at session end is filtered down to known themes and real chess moves before it is written into a student's memory.
- **Dependencies are pinned and self-hosted.** chess.js and the Daily SDK are served from the installed npm packages and the piece images live in the repo. The one exception is Daily's call engine, which its SDK fetches from Daily's CDN and evaluates; the Content-Security-Policy allows exactly that (`'unsafe-eval'` plus `c.daily.co`) and nothing else from outside.
- **A custom call UI, not Daily's prebuilt one.** The call runs on a Daily call object and the page renders the coach's video itself, so the panel shows the coach, captions and three controls instead of a meeting app's chrome.
- **The page stays quiet.** No instructions or commentary on screen: a board, the coach, and short status marks. Talking is the coach's job.

## How game review works

1. `POST /api/review` loads the PGN (or downloads it from Lichess's export API) and runs Stockfish over every position in two passes: a fast scan (depth 10), then a deeper re-check (depth 15) around every move the scan flagged. A typical game takes a few seconds and is cached.
2. Each move is scored by **lost winning chances**, using Lichess's win-probability curve rather than raw centipawns. Going from +9 to +6 is still completely winning and isn't flagged; going from +1 to -2 is. Losses of 10/20/30 points become inaccuracy / mistake / blunder.
3. The student's four costliest moves become **key moments**, each described in plain English (what was played, the evaluation before and after, the engine's preferred move and line).
4. The PAL gets a compact summary as a `[board]` message. Interaction messages are capped at 4 KB, so it carries the key moments, not the whole game.
5. When the student tries an alternative at a key moment, `POST /api/judge` accepts any move that keeps nearly all the winning chances of the engine's best (within 5 points), not just the single top move. Real games rarely have only one good move.

## What I'd do next

- **Perception tool:** a Raven visual query for "the student looks frustrated or stuck" that triggers an earlier hint.
- **Spaced repetition from memory:** schedule a theme you missed to come back two sessions later, and track each theme's hit rate over time.
- **Rating-based progression:** track a per-student puzzle rating instead of three levels, and pick puzzles near it.
- **Voice moves:** "knight to d6" spoken → move played, via a tool that parses the move and plays it on the board.
- **Play a game against the coach:** Stockfish at reduced strength as the opponent, with the coach speaking up only at moments that matter (a big swing, a tactic on the board), not on every move.
- **Real accounts:** a notebook key is a stand-in for signing in. A product would key memory to an authenticated user.

## Files

```
server/index.js        HTTP server: static files, /api/analyze, /api/session
server/engine.js       Stockfish wrapper: runs the engine in a child process (engine-worker.js), serialized queue, watchdog
server/chessText.js    positions and engine lines -> plain English
server/pal-config.js   system prompt, greeting, tool definitions (all PAL behavior in one file)
server/puzzles.js      puzzle selection: theme, level, no repeats
server/puzzle-pool.json  ~4,800 puzzles from the Lichess database (CC0), verified against our engine
server/themes.js       the 20 tactical patterns the coach teaches
scripts/import-puzzles.js  rebuilds the pool from the Lichess database
server/review.js       game review: per-move engine pass, mistake scoring, key moments, try-a-move judging
public/samples/        two sample games for the review mode
server/setup.js        idempotent Tavus setup (tools, PAL, attach); also runs on first boot
server/memory.js       student memory: session notes, sanitizing what the browser reports
server/limits.js       per-client rate limits
render.yaml            one-click Render deploy
server/audit.js        audit log: Postgres or in-memory store, redaction, batching
public/app.js          puzzle and review flow, tool handlers, interaction protocol, the call
public/board.js        board renderer: sliding pieces, drag and click moves, arrows, badges
public/sounds.js       synthesized move sounds (WebAudio, no audio files)
public/admin.*         the admin dashboard
public/about.*         the marketing page at /about (its boards are the app's board component)
public/pieces/         piece images (cburnett set, see LICENSE.txt there)
test/                  node:test suites; test/helpers.js has the fake Tavus API
```

## Licenses

The code in this repo is MIT. It runs [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL) as an npm dependency on the server, and the piece images in `public/pieces/` are by Colin M.L. Burnett (GPLv2+). The puzzles in `server/puzzle-pool.json` are from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0).
