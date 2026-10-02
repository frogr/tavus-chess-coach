// Registers the tools and one PAL per coach with Tavus and writes their IDs to
// .tavus.json. Runs from `npm run setup`, and automatically on server boot when
// no PAL is configured (e.g. a fresh Render deploy).
//
// Idempotent: tools are matched by name and patched, and each PAL is found by
// ID or by name and patched, so it never piles up duplicates.
require('./env');
const fs = require('fs');
const path = require('path');
const { tavus } = require('./tavus');
const { TOOLS, systemPrompt, greeting } = require('./pal-config');
const { COACHES } = require('./coaches');

const CONFIG_PATH = process.env.TAVUS_CONFIG_PATH || path.join(__dirname, '..', '.tavus.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function upsertTool(tool) {
  const existing = await tavus('GET', `/tools?type=user&limit=100&name_or_uuid=${encodeURIComponent(tool.name)}`);
  const match = (existing.data || []).find((t) => t.name === tool.name);
  if (match) {
    const { name, ...rest } = tool;
    await tavus('PATCH', `/tools/${match.tool_id}`, rest);
    console.log(`  updated tool ${tool.name} (${match.tool_id})`);
    return match.tool_id;
  }
  const created = await tavus('POST', '/tools', { origin: 'llm', ...tool });
  console.log(`  created tool ${tool.name} (${created.tool_id})`);
  return created.tool_id;
}

function palBody(coach) {
  return {
    pal_name: coach.pal_name,
    system_prompt: systemPrompt(coach),
    greeting: greeting(coach),
    pipeline_mode: 'full',
    default_face_id: coach.face_id,
    layers: {
      // The model has to call tools reliably: the coach drives the app through
      // them. Measured on 2026-10-02 in live calls with the same four requests, typed
      // in as the student's lines (start a
      // game, review it, go to the key moment, back to puzzles): Tavus's default
      // model made 1 of the 4 tool calls and claimed the rest; this one made 4 of 4.
      llm: { model: process.env.TAVUS_LLM_MODEL || 'tavus-gpt-4.1' },
      perception: { perception_model: 'raven-1' },
      conversational_flow: {
        turn_detection_model: 'sparrow-2',
        // Thinking about a chess move involves long silences. Be patient,
        // and nudge (not lecture) when the student goes quiet.
        turn_taking_patience: 'high',
        pal_interruptibility: 'high',
        idle_engagement: 'patient',
      },
      stt: {
        hotwords:
          'Chess vocabulary: knight, bishop, rook, queen, king, pawn, check, checkmate, castle, fork, pin, skewer, ' +
          'en passant, e4, d6, b7, f7, Nf3, Qb8, back rank, smothered mate.',
      },
    },
  };
}

const nameKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// A failed lookup throws rather than reporting "not found": treating an API
// hiccup as "no PAL yet" is how duplicates get created.
async function listPals() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const res = await tavus('GET', `/pals?limit=100&page=${page}&pal_type=user`);
    all.push(...(res.data || []));
    if (!res.data || res.data.length < 100) break;
  }
  return all;
}

function findPalByName(pals, name) {
  // Tavus strips punctuation from stored names, so compare letters and digits only.
  const hits = pals.filter((p) => nameKey(p.pal_name) === nameKey(name));
  // If there are several, always settle on the oldest so student memory (stored per PAL) stays put.
  hits.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return hits.length ? hits[0].pal_id : null;
}

// Creates or updates one coach's PAL and returns its ID.
async function upsertPal(coach, known, toolIds) {
  let palId = known;
  if (palId) {
    try {
      const ops = Object.entries(palBody(coach)).map(([k, v]) => ({ op: 'replace', path: `/${k}`, value: v }));
      await tavus('PATCH', `/pals/${palId}`, ops);
      console.log(`  updated PAL ${palId} (${coach.name})`);
    } catch (e) {
      // Only a PAL that no longer exists is replaced; any other failure is surfaced.
      if (e.status !== 404) throw e;
      console.log(`  PAL ${palId} no longer exists; creating a new one`);
      palId = null;
    }
  }
  if (!palId) {
    const created = await tavus('POST', '/pals', palBody(coach));
    palId = created.pal_id;
    console.log(`  created PAL ${palId} (${coach.name})`);
  }
  const attached = await tavus('GET', `/pals/${palId}/tools`).catch(() => ({}));
  const attachedIds = new Set((attached.data || attached.tools || []).map((t) => t.tool_id));
  const missing = toolIds.filter((id) => !attachedIds.has(id));
  if (missing.length) await tavus('POST', `/pals/${palId}/tools`, { tool_ids: missing });
  console.log(`  ${toolIds.length} tools attached (${missing.length} new)`);
  return palId;
}

// Resolves to { pal_id, pals }: the first coach's PAL, and every coach's PAL by key.
async function ensureSetup() {
  const config = readConfig();

  console.log('Tools:');
  const toolIds = [];
  for (const tool of TOOLS) toolIds.push(await upsertTool(tool));

  console.log('PALs:');
  let existing = null; // listed once, and only if a coach has no known ID
  const pals = {};
  for (const [i, coach] of COACHES.entries()) {
    let known = (i === 0 && (process.env.TAVUS_PAL_ID || config.pal_id)) || config.pals?.[coach.key];
    if (!known) known = findPalByName((existing ||= await listPals()), coach.pal_name);
    pals[coach.key] = await upsertPal(coach, known, toolIds);
  }
  const palId = pals[COACHES[0].key];

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ pal_id: palId, pals, tool_ids: toolIds }, null, 2));
  } catch {
    // read-only filesystem: the caller keeps the IDs in memory
  }
  return { pal_id: palId, pals };
}

module.exports = { ensureSetup };

if (require.main === module) {
  ensureSetup()
    .then(({ pal_id, pals }) => console.log(`\nPAL ready: ${pal_id}. Coaches: ${Object.keys(pals).join(', ')}. Now run: npm start`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
