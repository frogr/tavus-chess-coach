# Memory: how it works and what is guaranteed

This document answers one question: after a student's 10,000th session, how do we know the coach still remembers them correctly?

The short answer: the coach's memory is no longer the only copy. Every session is written to a permanent record this app owns (the **ledger**). What the coach reads is rebuilt from that record, checked after every write, and repaired at the start of every session. The parts of memory this app does not control are listed under [What is not guaranteed](#what-is-not-guaranteed).

## Contents

- [The three layers](#the-three-layers)
- [What is pinned, exactly](#what-is-pinned-exactly)
- [The life of a session](#the-life-of-a-session)
- [How a sync works](#how-a-sync-works)
- [Guarantees, and the test behind each](#guarantees-and-the-test-behind-each)
- [What is not guaranteed](#what-is-not-guaranteed)
- [At 10,000 sessions](#at-10000-sessions)
- [Checking that it is working](#checking-that-it-is-working)
- [Repairs](#repairs)
- [Tavus limits this relies on](#tavus-limits-this-relies-on)

## The three layers

| Layer | Where it lives | Written by | Kept for | Trust |
| --- | --- | --- | --- | --- |
| **Ledger** | Postgres, tables `student_sessions` and `student_sync` (`server/ledger.js`) | This app, from what happened on the board | Forever. It is never pruned. | Source of truth |
| **Pinned memories** | Tavus memory store, one per student per coach | This app, rebuilt from the ledger (`sync` in `server/memory.js`) | The profile note plus the 12 most recent session notes | A copy. Checked and repaired. |
| **Learned memory** | Tavus memory store | Tavus, from the conversation itself | Tavus decides | Not controlled by this app |

Everything in the first two layers comes from the board: which puzzles were solved, which moves were tried, how games ended. None of it comes from what the model thought happened, or from speech recognition. That matters because the coach can mishear a move or misremember a conversation; the board cannot.

## What is pinned, exactly

Two kinds of note, both plain sentences.

**One student profile.** Lifetime totals from every session in the ledger, replaced whenever the numbers change. It appears from the second session on.

```
Student profile, 214 sessions since 2026-09-12. Puzzles: 1840 tried, 1122 solved first try.
Lately needs work on skewer (2 of 9 first try). Lately strong at fork (18 of 20 first try),
pin (9 of 10 first try). Games against the coach: at 500 won 12, lost 3; at 1500 won 4,
lost 9, drew 1. Reviewed 37 of their own games.
```

- "Tried" and "solved first try" count every puzzle in every session. First try means no wrong move, no hint, not given up.
- "Lately" covers the last 30 sessions (`RECENT_SESSIONS`). A theme needs at least three attempts in that window to be mentioned. Strong is 70% or more first try; needs work is 50% or less. Up to three of each.
- Games count only finished games of three moves or more.

**Up to 12 session notes** (`KEEP_NOTES`), one per session, newest kept.

```
Session note 2026-10-01: solved first try: back-rank mate, pin. fork: tried Qd5, Nc7 first,
1 hint, then solved it. played the coach at strength 1500 as White: lost in 21 moves;
biggest mistakes 14. Qd6?.
```

A note holds at most three puzzles that needed help, one reviewed game and the last two games against the coach. The ledger row keeps the whole session (up to 40 puzzles, 6 games).

Both kinds are at most 500 characters. When there is too much to say, whole clauses are dropped from the end; a note is never cut mid-sentence.

At the start of a session the profile and the last three session notes are also placed in the conversation's context, read from the ledger, so the greeting does not depend on the Tavus store being right.

## The life of a session

1. **Start** (`POST /api/session`). The student is identified by a tag derived from their name and their notebook key. The chosen coach's store is synced from the ledger. The profile and last three notes go into the conversation context.
2. **During the call.** Every 20 seconds, if anything changed on the board, the browser posts the session so far to `POST /api/session/checkpoint`. It is written to the ledger only. Nothing is sent to Tavus yet.
3. **End** (`POST /api/session/end`, from the End button or from the browser's unload beacon when the tab closes). The session is written to the ledger first. Then all four coaches' stores are synced, in parallel. The response says whether the ledger write succeeded (`saved`) and whether every store now matches (`pinned`).
4. **If the end never arrives** (crashed tab, dead battery, lost network), the last checkpoint is already in the ledger. The note is pinned by the sync at step 1 of the next session.

A session is one ledger row, keyed by student and conversation. Writing it again replaces it, so a checkpoint followed by the end, or the end reported twice, leaves one row and one note.

## How a sync works

`sync(palId, tag)` makes one coach's store match the ledger:

1. Read the student's sessions from the ledger. Work out what should be pinned: the profile, and the last 12 distinct session notes.
2. Read what is pinned in the store.
3. Remove: profile notes that no longer match, exact duplicates, and session notes beyond the 12 kept.
4. Add: anything that should be pinned and is not. This is the step that repairs an earlier failed write.
5. Read the store back and compare it with step 1. Record the result in `student_sync` and in the audit log (`memory.sync`, or `memory.sync.error` with the reason).

Rules it follows:

- It only touches notes that start with `Session note` or `Student profile`. Anything pinned by hand in the Tavus dashboard is left alone.
- Session notes that exist in the store but not in the ledger (from before the ledger existed) stay while there is room among the 12, newest first.
- Two syncs of the same store never run at the same time in one server process.
- It never throws. A failure is a result (`ok: false`) that the next sync retries.

## Guarantees, and the test behind each

All in `test/memory-sync.test.js` and `test/tavus-flow.test.js`, run against a fake Tavus that enforces the real limits.

| Guarantee | Test |
| --- | --- |
| A session, once the ledger write returns, is never dropped: not by the 30-note limit, not by a deploy, not by a Tavus outage. | "every session, synced…" (120 sessions, ledger holds 120) |
| The store never exceeds Tavus's limits, so writes do not start failing as history grows. At most 13 notes, each at most 500 characters. | same test, checked after every session |
| The newest session's note is always pinned after a successful sync, and there is exactly one profile. | same test |
| Session 1 still counts at session 10,000: the profile's totals equal the sum of every ledger row. | "10,000 sessions…" |
| A write Tavus refuses is reported to the caller, kept in the ledger, and pinned by the next sync. | "a write Tavus refuses is reported…" |
| A session whose end was never reported is pinned at the next session start. | "a checkpoint with no end-of-call report…" |
| Ending the same session twice pins one note. | "ending the same session twice…" |
| Sync does not delete what it did not write, and removes duplicates and stale profiles. | "sync leaves alone what it did not write…" |
| A note is never cut mid-sentence. | "notes and profiles are cut at clause boundaries…" |
| Only board facts are stored: known themes, legal-looking moves, fixed result words. Text injected through the browser is dropped. | `test/memory.test.js`, "ending the session… pins a sanitized note" |
| Someone typing another student's name, without their key, reads and changes nothing. | "someone else typing the same name…" |

## What is not guaranteed

Stated plainly, because these are the ways memory can still be wrong.

- **Learned memory is Tavus's.** Tavus builds it from the conversation, which includes anything the speech recognizer misheard and anything the model got wrong. This app cannot inspect how it is built, correct it, or verify it. The system prompt tells the coach that when a learned memory disagrees with a session note or the profile, the note is right. That is an instruction to a language model, not a mechanism.
- **The coach can still misuse a correct note.** The notes are exact; how the model paraphrases them aloud is not. It can blur "2 of 9" into "you usually miss these". What it was given is recorded per session (see [Checking](#checking-that-it-is-working)), so a wrong statement can be traced to either a wrong note (our bug) or a wrong reading (the model).
- **Nothing said out loud is in the ledger.** Goals, preferences and anything else the student only said live in learned memory alone.
- **Identity is a name plus a key in the browser.** Clear the browser's storage, switch device without copying the key, or type the name differently ("Sam" then "Sam S") and a new, empty notebook starts. The old one still exists in the ledger and can be joined back by hand (see [Repairs](#repairs)).
- **The session report comes from the browser.** It is filtered, but a student can alter their own record by posting a made-up report. They can only affect their own notebook.
- **Up to 20 seconds can be lost** if the tab dies before the next checkpoint and never reports the end.
- **Without `DATABASE_URL` the ledger is in process memory** and is lost on restart. In that mode a sync adds and trims but has no history to rebuild from. Production must set it.
- **If the database is down at session end**, the note is not saved. The response says so (`saved: false`) and `memory.ledger.error` is recorded. There is no queue that retries a ledger write later.
- **The four coaches' stores are synced separately.** One can be behind the others after a partial failure. It catches up the next time that coach starts a session, or at the end of any later session.
- **"Lately" is 30 sessions, not time.** A student who returns after a year gets year-old "lately" figures until new sessions replace them.

## At 10,000 sessions

For one student with 10,000 sessions (three puzzles and a game each):

| | |
| --- | --- |
| Pinned in each coach's store | 13 notes, at most 6,500 characters, the same as at session 13 |
| Ledger size | about 0.5 KB a session, so about 5 MB |
| Work per sync | one query returning that student's rows, then about 20 ms to build the profile |
| Tavus calls per sync | 2 when nothing changed; typically 7 after a new session (find, read, 2 deletes, 2 writes, read back) |
| Time per sync (measured against the live API, 2026-10-02) | about 4 seconds when there is something to write, since each Tavus call takes roughly half a second. Session end syncs the four coaches in parallel, so it also takes about 4 seconds. A session start with nothing to repair makes two calls. |

The ledger query reads every row for the student each time. That is the first thing to change if a single student ever passes roughly 50,000 sessions: store the running totals instead of recomputing them.

For 10,000 different students the cost per session is unchanged. Each student has four Tavus stores (one per coach), created the first time they finish a session. Whether Tavus limits the number of stores on an account has not been tested.

## Checking that it is working

- **Admin dashboard** (`/admin`): the header shows `memory: N students, M sessions, in sync` or the number of coach stores that failed their last sync.
- **Per session** (`/admin`, open a session): "Memory notes sent" and "Profile sent" are what the coach was told at the start; "Note saved" is the note written to the ledger at the end; "Note pinned" says whether every coach's store took it, and which did not.
- **Events** (`/admin`, Events, filter by kind `memory`): `memory.sync`, `memory.sync.error`, `memory.ledger.error`.
- **Notebook panel** in the app: shows what is pinned for the current student and coach.
- **SQL**, for the same facts directly:

```sql
-- Stores whose last sync failed
select tag, pal_id, checked_at, pinned, detail from student_sync where not ok order by checked_at desc;

-- One student's full history
select ended_at, conversation_id, note from student_sessions where tag = 'chess-student-sam-…' order by ended_at;

-- Sessions per student
select tag, count(*) as sessions, min(ended_at) as first, max(ended_at) as last from student_sessions group by tag order by sessions desc;
```

## Repairs

- **A store is out of sync.** Nothing to do: the next session start for that coach, or the next session end for that student, repairs it. If it keeps failing, `detail` in `student_sync` holds Tavus's error.
- **A Tavus store was deleted or emptied.** The next sync recreates it and pins the profile and the last 12 notes from the ledger. Learned memory in that store is gone; this app has no copy of it.
- **A student lost their notebook key.** Their sessions are still in the ledger under the old tag. With both tags known (the old one from the audit log's session record, the new one from a session started with the new key):

```sql
update student_sessions set tag = '<new tag>' where tag = '<old tag>';
```

  The next sync pins the rebuilt profile and notes under the new key.
- **Sessions from before the ledger existed.** `node scripts/backfill-ledger.js` copies them from the audit log. It was run on 2026-10-02 (2 of 15 audited sessions had a student and a board summary). The audit log keeps session records but prunes events after 90 days.

## Tavus limits this relies on

Measured against the live API on 2026-10-02 with a throwaway store, and mirrored by the fake in `test/helpers.js`:

- A pinned memory longer than 500 characters is refused (400).
- The 31st pinned memory in a store is refused (400, "Pinned memory limit reached (30 per store)").
- Deleting a pinned memory that is already gone returns 404, which a sync treats as success.
- A store is looked up by PAL and participant tag, so the same tag always reaches the same store.

If Tavus changes these, the sync's read-back is what will notice: stores will show as out of sync on the admin dashboard.
