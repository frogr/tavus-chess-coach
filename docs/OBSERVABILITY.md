# Observability: every input and output, and where to find it

The rule for this project: nothing that goes into or comes out of the coach, the engine, the board or the server may exist only in someone's browser or only inside Tavus. If it happened, there is a record of it on the server.

This document lists each input and output, where it is recorded, and how to look it up. The short list of things that are still not recorded is at the end, with the reason for each.

## Where records live

All in the Postgres database named by `DATABASE_URL`.

| Table | What it holds | Kept |
| --- | --- | --- |
| `audit_events` | One row per event: every HTTP request, every Tavus API call, every Tavus webhook, every event the browser reports | Forever by default (`AUDIT_RETENTION_DAYS=0`) |
| `audit_sessions` | One row per call: who, which coach, what the coach was told, memory before and after, the board summary, Tavus's transcript and its own record of the call | Forever |
| `student_sessions` | The memory ledger: one row per session per student (see [MEMORY.md](MEMORY.md)) | Forever |
| `student_sync` | The result of the last memory sync for each student and coach | Latest only |
| `student_games` | Every game against a coach, replaced after every move | Forever |

**Production and development are different databases.** Render's `DATABASE_URL` is the production one (Neon project `raspy-river-96307223`). The `.env` on a developer machine points at a separate development database. A session that happened on coach-rook.onrender.com is only in production. `server.boot` events carry the commit, which tells the two apart: development boots have `commit: null`.

## Inputs to the coach

| Input | Recorded as | Where |
| --- | --- | --- |
| The system prompt and tool definitions | Tavus API calls at setup (`tavus.api`, `PATCH /pals/…`), and in full at the top of every call's transcript | `audit_events`; `audit_sessions.data.transcript` |
| The conversation context and greeting for a call | `context`, `greeting`, `notes_sent`, `profile_sent` | `audit_sessions.data` |
| Everything in the coach's memory store when the call began: pinned notes and Tavus's learned memory | `memory_before` | `audit_sessions.data` |
| Every message the board sends during a call (`conversation.respond`, `append_llm_context`, `tool_result`, `echo`) | `tavus.sent`, with the full text | `audit_events` |
| What the student said, as Tavus transcribed it | `tavus.received` (`conversation.utterance`, role `user`) and the transcript | `audit_events`; `audit_sessions.data.transcript` |
| What Tavus saw on camera | `tavus.webhook:application.perception_analysis` | `audit_events` |

## Outputs from the coach

| Output | Recorded as | Where |
| --- | --- | --- |
| Everything the coach said | `tavus.received` (`conversation.utterance`, role `replica`) and the transcript | `audit_events`; `audit_sessions.data.transcript` |
| Every tool call, with its arguments | `tavus.received` (`conversation.tool_call`) and `feed:tool_call → <name>` | `audit_events` |
| What each tool returned to the coach | `feed:tool_result ← <name>` and `tavus.sent` (`conversation.tool_result`) | `audit_events` |
| Each utterance as it was spoken, word by word, with whether it was interrupted | `tavus.received` (`conversation.utterance.streaming`) | `audit_events` |
| Which model answered, and when it started and stopped thinking and speaking | `tavus.received` (`conversation.replica.*`) | `audit_events` |
| Why the call ended | `tavus.webhook:system.shutdown` | `audit_events`; `audit_sessions.data.shutdown` |
| Everything in every coach's memory store once the call ended | `memory_after` | `audit_sessions.data` |

## The board and the engine

| What | Recorded as |
| --- | --- |
| Every puzzle loaded, every move tried, whether it was right, hints, solutions shown, rating changes | `puzzle.load`, `puzzle.move`, `puzzle.solved`, `puzzle.rated`, … |
| Every move in a game against a coach, the engine's verdict on it, the coach's reply, take-backs, the result | `play.new`, `play.move`, `play.judge`, `play.reply`, `play.takeback`, `play.end` |
| The whole game as PGN, after every move | `student_games` |
| Every game loaded for review, its key moments, every move stepped to, every retry and its verdict | `review.load`, `review.goto`, `review.moment`, `review.try` |
| Every engine request and its full answer (analysis, review, a coach's move) | `http`, with request and response |
| Switching between puzzles, play and review; every button, link and tab pressed | `ui.mode`, `ui.click` |
| Errors in the page; requests that never reached the server | `client.error`, `client.request_failed` |
| Call lifecycle: joined, tracks started, network quality, left | `call.*` |

## The server

| What | Recorded as |
| --- | --- |
| Every API request: method, path, status, timing, request body, response body | `http` |
| Every call to Tavus: request, response, status, timing | `tavus.api`, `tavus.api.error` |
| Every Tavus webhook, whole | `tavus.webhook:<event>` |
| Every memory sync and its result; ledger write failures | `memory.sync`, `memory.sync.error`, `memory.ledger.error` |
| Boots, crashes, unhandled errors | `server.boot`, `server.error` |

## How records are kept from getting lost

- **Browser to server.** Events are sent in batches every two seconds. A batch that fails is put back and sent again; up to 5,000 events wait while the server is unreachable. When the page closes, what is left is sent with a beacon.
- **Server to database.** Events are written in batches every second. A batch that fails to write is kept and retried; up to 50,000 events wait while the database is unreachable.
- **Size.** One event holds up to 256 KB (a full game review is about 60 KB). Transcripts and Tavus's own conversation records hold up to 2 MB. Anything larger is cut, and the event says so with its original size.
- **Games** are written to `student_games` after every move, not when the game ends, so a call that ends mid-game loses nothing.
- **Sessions** are checkpointed to the ledger every 20 seconds during a call.

## Looking things up

- **Admin dashboard** (`/admin`): sessions, visits, and a searchable event list. Opening a session shows its timeline, what the coach was told, the transcript (browser's and Tavus's), and the memory facts.
- **SQL**, for anything the dashboard does not show:

```sql
-- The latest calls
select conversation_id, started_at, ended_at, data->>'player', data->>'coach' from audit_sessions order by started_at desc limit 10;

-- One call, in order: what was said, what the board sent, every tool call and result
select ts, kind, data from audit_events where conversation_id = '<id>' and kind not in ('http', 'tavus.api') order by id;

-- Every tool call and what it returned, across all calls
select ts, conversation_id, kind, data->>'detail' from audit_events where kind like 'feed:tool_%' order by id desc limit 50;

-- What a coach's memory held before and after a call
select data->'memory_before', data->'memory_after' from audit_sessions where conversation_id = '<id>';

-- A student's games
select game_id, updated_at, data->>'opponent', data->>'result', data->>'pgn' from student_games order by updated_at desc limit 20;

-- Rebuild a game from its moves, if it predates student_games
select data->>'san' from audit_events where conversation_id = '<id>' and kind in ('play.move', 'play.reply') order by id;
```

## What is still not recorded, and why

- **Tavus's once-a-second "still here" heartbeats.** They carry no content.
- **Secrets.** The access code, notebook keys, tokens and API keys are replaced with `[redacted]` before anything is stored. This is deliberate.
- **Raw audio and video of the call.** Only the transcript and Tavus's perception analysis are kept. Tavus can record calls, but only into an S3 bucket the account owner provides; none is configured.
- **How Tavus derives learned memory, and the model's internal reasoning.** These happen inside Tavus. What goes in (the transcript, the context) and what comes out (the learned memory itself, before and after each call; every utterance and tool call) are recorded.
- **Events still queued when something dies.** If the browser is killed while offline, or the server restarts while the database is unreachable, the events waiting in memory at that moment are lost. Tavus's webhooks (transcript, shutdown reason) arrive independently of the browser and still record the call.
