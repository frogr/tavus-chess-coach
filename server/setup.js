// Registers the coach's tools and PAL with Tavus and writes their IDs to
// .tavus.json. Runs from `npm run setup`, and automatically on server boot when
// no PAL is configured (e.g. a fresh Render deploy).
//
// Idempotent: tools are matched by name and patched, and the PAL is found by
// ID or by name and patched, so it never piles up duplicates.
require('./env');
const fs = require('fs');
const path = require('path');
const { tavus } = require('./tavus');
const { TOOLS, SYSTEM_PROMPT, GREETING } = require('./pal-config');

const CONFIG_PATH = path.join(__dirname, '..', '.tavus.json');
const FACE_ID = process.env.TAVUS_FACE_ID || 'rc9cff32ceba'; // stock "Anna" face

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

function palBody() {
  return {
    pal_name: PAL_NAME,
    system_prompt: SYSTEM_PROMPT,
    greeting: GREETING,
    pipeline_mode: 'full',
    default_face_id: FACE_ID,
    layers: {
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

const PAL_NAME = 'Coach Rook (chess puzzles)';
const nameKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function findPalByName() {
  for (let page = 1; page <= 5; page++) {
    const res = await tavus('GET', `/pals?limit=100&page=${page}&pal_type=user`).catch(() => ({ data: [] }));
    // Tavus strips punctuation from stored names, so compare letters and digits only.
    const hit = (res.data || []).find((p) => nameKey(p.pal_name) === nameKey(PAL_NAME));
    if (hit) return hit.pal_id;
    if (!res.data || res.data.length < 100) return null;
  }
  return null;
}

async function ensureSetup() {
  const config = readConfig();

  console.log('Tools:');
  const toolIds = [];
  for (const tool of TOOLS) toolIds.push(await upsertTool(tool));

  console.log('PAL:');
  let palId = process.env.TAVUS_PAL_ID || config.pal_id || (await findPalByName());
  if (palId) {
    try {
      const body = palBody();
      const ops = Object.entries(body).map(([k, v]) => ({ op: 'replace', path: `/${k}`, value: v }));
      await tavus('PATCH', `/pals/${palId}`, ops);
      console.log(`  updated PAL ${palId}`);
    } catch (e) {
      console.log(`  could not patch ${palId} (${e.status}); creating a new one`);
      palId = null;
    }
  }
  if (!palId) {
    const created = await tavus('POST', '/pals', palBody());
    palId = created.pal_id;
    console.log(`  created PAL ${palId}`);
  }

  const attached = await tavus('GET', `/pals/${palId}/tools`).catch(() => ({}));
  const attachedIds = new Set((attached.data || attached.tools || []).map((t) => t.tool_id));
  const missing = toolIds.filter((id) => !attachedIds.has(id));
  if (missing.length) await tavus('POST', `/pals/${palId}/tools`, { tool_ids: missing });
  console.log(`  ${toolIds.length} tools attached (${missing.length} new)`);

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ pal_id: palId, face_id: FACE_ID, tool_ids: toolIds }, null, 2));
  } catch {
    // read-only filesystem: the caller keeps the ID in memory
  }
  return palId;
}

module.exports = { ensureSetup };

if (require.main === module) {
  ensureSetup()
    .then((id) => console.log(`\nPAL ready: ${id}. Now run: npm start`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
