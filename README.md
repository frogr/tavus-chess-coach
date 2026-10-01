# Coach Rook: a chess coach with a face

A live video chess tutor built on Tavus CVI. You solve tactics puzzles on a real board while a PAL watches every move, talks you through hints, **points at squares on your screen**, and checks every claim against Stockfish before making it.

```
npm install
cp .env.example .env        # add TAVUS_API_KEY
npm run setup               # registers 4 tools + the PAL, writes .tavus.json
npm start                   # http://localhost:3000
```

Open `http://localhost:3000/?sim=1` to try the board and every tool handler with a simulator, without spending conversation minutes.

## Why this project

Coaching is where face-to-face AI is strongest. A good chess coach isn't a database of answers. They watch you think, wait while you stare at the board, ask a question instead of giving the move away, and point: "look at *this* knight." Text chat can't do the waiting or the pointing. A video PAL can, as long as it's wired into the thing you're both looking at.

It's also a demanding integration test, which made it a useful one to build. Chess punishes an LLM that improvises: a coach that confidently calls a blunder "brilliant" loses the student's trust immediately. So the interesting work is the same work a customer engineer does for every PAL: deciding **what the model is trusted with and what it isn't**, and building the plumbing that keeps it honest.

## Architecture

```
 Browser                                               Tavus CVI
┌────────────────────────────────────────┐          ┌──────────────────────┐
│  Board (chess.js)  ── source of truth   │          │  PAL "Coach Rook"    │
│        │                                │  app     │  Raven-1 perception   │
│        ├─ student moves ──► respond ────┼─message─►│  Sparrow-2 (patient)  │
│        ├─ puzzle loads ─► append_context│  (Daily) │  LLM + 4 tools        │
│        │                                │          │  memory per student   │
│  Tool handlers ◄─── conversation.tool_call ────────┤                      │
│        │        ───► conversation.tool_result ────►│                      │
│  Daily iframe (video)                   │          └──────────────────────┘
└────────┬───────────────────────────────┘
         │ /api/analyze, /api/session
┌────────▼───────────────────────────────┐
│  Node server                           │
│   Stockfish (WASM) + plain-English     │──► tavusapi.com/v2 (API key stays here)
│   puzzle set (engine-verified)         │
└────────────────────────────────────────┘
```

**Two directions of traffic, both over the interaction protocol:**

1. **Board → PAL.** Every student move becomes a `conversation.respond` event tagged `[board]`, already annotated with ground truth: was it correct, what the opponent replied, and for wrong moves, what the engine says the move allowed. The PAL reacts as if it watched the move. Puzzle loads go in as `conversation.append_llm_context`, including the solution marked "for the coach only", so hints are graded instead of guessed.
2. **PAL → board.** Four tools with app-message delivery, handled in the browser:

| Tool | What it does | `on_call` / `on_resolve` | Why |
|---|---|---|---|
| `chess_analyze_position` | Stockfish on the current board, optionally comparing a move the student asked about | `static_filler` / `generate_response` | Engine takes ~1s; a fixed "let me check that with the engine" sounds natural and is honest about what's happening |
| `chess_show_on_board` | Highlights squares and draws arrows on the student's board | `generate_filler` / `add_to_context` | The generated filler *is* the explanation, spoken while the highlight appears. Nothing to say after, so the result just lands in context |
| `chess_load_puzzle` | next / retry / easier / harder | `silent` / `generate_response` | The PAL introduces the new puzzle from the description it gets back |
| `chess_play_solution` | Animates the full answer | `silent` / `generate_response` | Only when the student gives up |

## Decisions worth calling out

- **The model never does chess.** It narrates, asks, encourages, and points. Correctness comes from the board (move validation) and Stockfish (evaluation). The system prompt says so explicitly, and the tools make the right path the easy one.
- **No FEN or UCI reaches the LLM.** LLMs misread FEN constantly. The server turns positions into "White: king on g1; rook on d1…" and engine lines into "knight from e4 to d6, with check; White is completely winning (+7.6)". This was the single biggest reliability lever.
- **Every puzzle is engine-verified.** `npm run verify-puzzles` checks that each solution's first move is Stockfish's unique top choice and the line is decisive. I rejected two of my own candidates this way (one had several equally winning answers, one was a dead draw).
- **Turn-taking tuned for thinking.** Chess means long silences. `turn_taking_patience: high` stops the coach from jumping in while you calculate, and `idle_engagement: patient` gives a gentle nudge rather than an answer when you go quiet.
- **Memory per student.** Entering a name sets a `participant_tags` value, so next session Coach Rook can say "last time the back-rank stuff clicked, let's try something harder."
- **STT hotwords** for chess vocabulary ("Nf3", "en passant", "skewer"), which general STT mangles.
- **Key stays on the server.** The browser only ever gets a `conversation_url`.
- **Setup is code, not clicks.** `npm run setup` is idempotent: tools are matched by name and patched, the PAL is patched in place. A customer can re-run it after every prompt change and diff the config in git.
- **"Under the hood" panel.** Every tool call, tool result, and board event is shown live. It's for the demo, but it's also the debugging view I'd want when a customer says "the PAL did something weird."

## What I'd do next

- **Perception tool:** a Raven visual query for "the student looks frustrated or stuck" that triggers an earlier hint.
- **Post-call action:** write a short session summary (patterns missed, patterns learned) into pinned memory, rather than relying only on learned memory.
- **Real puzzle supply:** the Lichess puzzle database filtered by theme and rating, with the same verify step in the import.
- **Voice moves:** "knight to d6" spoken → move played, via a tool that parses the move and plays it on the board.
- **Hosted deploy** (Render/Fly) so it runs from a link.

## Files

```
server/index.js        HTTP server: static files, /api/analyze, /api/session
server/engine.js       Stockfish wrapper (serialized queue, MultiPV 3)
server/chessText.js    positions and engine lines -> plain English
server/pal-config.js   system prompt, greeting, tool definitions (all PAL behavior in one file)
server/puzzles.js      6 engine-verified teaching puzzles
scripts/setup.js       idempotent Tavus setup (tools, PAL, attach)
public/app.js          board, tool handlers, interaction protocol, Daily embed
```
