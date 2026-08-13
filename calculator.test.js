/**
 * Unit tests for the Solaris Capacity Calculator engine.
 * Loads the calculation functions straight out of the HTML file behind a DOM stub.
 *
 *   node calculator.test.js
 */
const fs = require('fs');
const path = require('path');

/* ── load the engine ───────────────────────────────────────── */
const js = fs.readFileSync(path.join(__dirname, 'assets', 'app.js'), 'utf8');

const stubEl = () => ({
  value: '', textContent: '', disabled: false,
  set innerHTML(v) {}, get innerHTML() { return ''; },
  set className(v) {},
  classList: { toggle: () => false, add() {}, remove() {}, contains: () => true },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  focus() {}, closest: () => null, style: {}, dataset: {},
});
global.document = {
  getElementById: stubEl, querySelector: stubEl, querySelectorAll: () => [],
  addEventListener() {}, activeElement: null,
};
global.window = { scrollTo() {} };

const mod = { exports: {} };
new Function('module', 'document', 'window', js + `
;module.exports = { K, RESERVE, TIER, BLAST, VARIANTS, INTENSITY, AI_USE,
  tierOf, blastCount, buildWorkers, compute, capacity, pointsOf, snapshot, throughput,
  safeMaxConn, maxConn, usableConn, healthyActive, serverLimits, recommend, PROFILES, roles, blankForm, reserveFor, smallestApp,
  S, servers, getApps: () => apps, setApps: a => { apps = a; } };
`)(mod, global.document, global.window);

const E = mod.exports;

/* ── tiny test harness ─────────────────────────────────────── */
let pass = 0, fail = 0;
const results = [];

function it(name, fn) {
  try { fn(); pass++; results.push(['  PASS', name, '']); }
  catch (err) { fail++; results.push(['  FAIL', name, err.message]); }
}
function eq(actual, expected, what = '') {
  if (actual !== expected) throw new Error(`${what || 'value'}: expected ${expected}, got ${actual}`);
}
function near(actual, expected, tol, what = '') {
  if (Math.abs(actual - expected) > tol) throw new Error(`${what || 'value'}: expected ~${expected} (±${tol}), got ${actual}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function group(name) { results.push(['', '', '']); results.push(['##', name, '']); }

/* ── fixtures ──────────────────────────────────────────────── */
const app = over => ({ ...E.blankForm(), ...over });

function singleServer(cores = 8, ram = 16, disk = 500) {
  E.S.deploy = 'single'; E.S.storage = 'minio'; E.S.pooling = 'pgbouncer'; E.S.reserve = 'standard';
  E.S.redisDb = E.K.redisDbs; E.S.maxConn = null;
  E.servers.single = { cores, ram, disk };
}
function clusterServers() {
  E.S.deploy = 'cluster'; E.S.storage = 'minio'; E.S.pooling = 'pgbouncer'; E.S.reserve = 'standard';
  E.S.maxConn = null;
  E.servers.app = { cores: 8, ram: 16, disk: 200 };
  E.servers.db = { cores: 4, ram: 16, disk: 300 };
  E.servers.storage = { cores: 2, ram: 4, disk: 2000 };
}

/* ═══════════════════════════════════════════════════════════ */
group('Tier classification');

it('score = users × intensity weight', () => {
  eq(E.tierOf(10, 'light').score, 10);
  eq(E.tierOf(10, 'moderate').score, 25);
  eq(E.tierOf(10, 'heavy').score, 50);
});

it('boundaries land on the right tier', () => {
  eq(E.tierOf(50, 'light').tier, 'low', 'score 50');
  eq(E.tierOf(51, 'light').tier, 'medium', 'score 51');
  eq(E.tierOf(200, 'light').tier, 'medium', 'score 200');
  eq(E.tierOf(201, 'light').tier, 'high', 'score 201');
});

it('minimum subscription of 5 users is always Low', () => {
  eq(E.tierOf(5, 'heavy').tier, 'low', '5 heavy users');
});

it('realistic profiles land where expected', () => {
  eq(E.tierOf(15, 'moderate').tier, 'low', '15 moderate');
  eq(E.tierOf(30, 'moderate').tier, 'medium', '30 moderate');
  eq(E.tierOf(60, 'heavy').tier, 'high', '60 heavy');
});

/* ═══════════════════════════════════════════════════════════ */
group('WhatsApp AI assistant — a staff tool, so it scales with headcount');

it('nothing at all when the switch is off', () => {
  singleServer();
  const a = E.compute(app({ useAi: false, aiUse: 'constant', users: 200 }));
  eq(a.waAi, 0, 'no processes');
  eq(a.aiUsers, 0, 'nobody using it');
  eq(a.waMsgHour, 0, 'no messages');
  eq(a.waRowsDay, 0, 'and no database growth');
});

it('volume is people × conversations a day × questions per conversation', () => {
  singleServer();
  for (const level of ['occasional', 'regular', 'constant']) {
    const a = E.compute(app({ useAi: true, aiUse: level, users: 60 }));
    const cfg = E.AI_USE[level];
    eq(a.aiUsers, Math.round(60 * cfg.share), `${level}: people using it`);
    eq(a.aiSessionsDay, a.aiUsers * cfg.sessions, `${level}: conversations a day`);
    eq(a.waMsgDay, a.aiSessionsDay * E.K.aiTurns, `${level}: messages a day`);
    near(a.waMsgHour, a.waMsgDay / E.K.waActiveHours * E.K.aiPeakFactor, 0.001, `${level}: peak hour`);
  }
});

it('the busy hour carries more than the flat average', () => {
  singleServer();
  const a = E.compute(app({ useAi: true, aiUse: 'regular', users: 60 }));
  const flat = a.waMsgDay / E.K.waActiveHours;
  near(a.waMsgHour / flat, E.K.aiPeakFactor, 0.001, 'peak factor applied');
});

it('a person who uses it sends a believable number of messages', () => {
  singleServer();
  const perPersonDay = level => {
    const a = E.compute(app({ useAi: true, aiUse: level, users: 60 }));
    return a.waMsgDay / a.aiUsers;
  };
  ok(perPersonDay('occasional') >= 5, `occasional should be at least a handful, got ${perPersonDay('occasional')}`);
  ok(perPersonDay('constant') <= 80, `constant should stay this side of absurd, got ${perPersonDay('constant')}`);
  ok(perPersonDay('occasional') < perPersonDay('regular'), 'levels must be ordered');
  ok(perPersonDay('regular') < perPersonDay('constant'), 'levels must be ordered');
});

it('database rows count the whole day, not the peak hour twice over', () => {
  singleServer();
  const a = E.compute(app({ useAi: true, aiUse: 'constant', users: 60 }));
  eq(a.waRowsDay, Math.round(a.waMsgDay * E.K.waRowsPerMsg), 'derived from the daily total');
  ok(a.waRowsDay < a.waMsgHour * 24 * E.K.waRowsPerMsg, 'peak rate must not be treated as all-day');
});

it('more staff means more assistant traffic', () => {
  singleServer();
  const small = E.compute(app({ useAi: true, aiUse: 'regular', users: 10 }));
  const big = E.compute(app({ useAi: true, aiUse: 'regular', users: 200 }));
  ok(big.waMsgHour > small.waMsgHour * 10, 'volume tracks headcount');
  ok(big.waAi > small.waAi, `and so does the process count: ${small.waAi} → ${big.waAi}`);
});

it('heavier adoption at the same headcount needs more processes', () => {
  singleServer();
  const at = level => E.compute(app({ useAi: true, aiUse: level, users: 200 })).waAi;
  ok(at('occasional') <= at('regular'), 'occasional is never above regular');
  ok(at('regular') < at('constant'), `regular ${at('regular')} should be under constant ${at('constant')}`);
});

it('processes follow (messages/h × 18 s ÷ 3600) ÷ 0.5 utilisation', () => {
  singleServer();
  const a = E.compute(app({ useAi: true, aiUse: 'constant', users: 200 }));
  eq(a.waAi, Math.ceil((a.waMsgHour * E.K.waAiSec / 3600) / E.K.waAiUtil));
});

it('even a five-person team gets one process when the switch is on', () => {
  singleServer();
  const a = E.compute(app({ useAi: true, aiUse: 'occasional', users: 5 }));
  eq(a.waAi, 1, 'never rounds down to zero');
  ok(a.aiUsers >= 1, 'at least one person is using it');
});

/* ═══════════════════════════════════════════════════════════ */
group('Blast workers');

it('none means no processes', () => {
  eq(E.blastCount('none', 'slow'), 0);
  eq(E.blastCount('none', 'default'), 0);
  eq(E.blastCount('none', 'fast'), 0);
});

it('slow collapses any volume into a single lane', () => {
  eq(E.blastCount('occasional', 'slow'), 1);
  eq(E.blastCount('heavy', 'slow'), 1);
});

it('fast splits into send / schedule / webhook', () => {
  eq(E.blastCount('occasional', 'fast'), 3);
  eq(E.blastCount('heavy', 'fast'), 6);
});

it('blast workers only exist on Marketing and CRM', () => {
  singleServer();
  const sales = E.compute(app({ variant: 'sales', waBlast: 'heavy', emailBlast: 'heavy' }));
  ok(!sales.workers.some(w => w.name.includes('blast')), 'Sales must not get blast workers');
  const crm = E.compute(app({ variant: 'crm', waBlast: 'heavy', emailBlast: 'heavy' }));
  ok(crm.workers.some(w => w.name.includes('wa-blast')), 'CRM should get blast workers');
});

/* ═══════════════════════════════════════════════════════════ */
group('Worker layout');

it('the three layouts are genuinely different shapes', () => {
  singleServer();
  const base = { variant: 'sales', users: 15, intensity: 'moderate', useAi: true, aiUse: 'occasional', waTransport: 'redis' };
  const names = l => E.compute(app({ ...base, layout: l })).workers.map(w => `${w.name}×${w.count}`).join(' | ');
  const slow = names('slow'), def = names('default'), fast = names('fast');
  ok(slow !== def, `slow and default must differ:\n    ${slow}\n    ${def}`);
  ok(def !== fast, 'default and fast must differ');
});

it('the layout decides the plan, not the tier', () => {
  singleServer();
  const shape = users => E.compute(app({ variant: 'sales', users, intensity: 'moderate', layout: 'default' }))
    .workers.map(w => `${w.name}×${w.count}`).join('|');
  eq(shape(10), shape(150), 'a Low and a High tier app get the same layout when told to');
});

it('slow keeps batch-delete on the interactive lane', () => {
  singleServer();
  const a = E.compute(app({ layout: 'slow' }));
  ok(a.workers.some(w => w.name === 'default + notification + batch-delete'), 'one shared lane');
  ok(!a.workers.some(w => w.name === 'batch-delete'), 'not split out');
});

it('default splits batch-delete out and doubles the AI', () => {
  singleServer();
  const a = E.compute(app({ layout: 'default', useAi: true, aiUse: 'occasional' }));
  ok(a.workers.some(w => w.name === 'default + notification'), 'interactive lane without the deletes');
  eq(a.workers.find(w => w.name === 'batch-delete').count, 1, 'its own lane');
  eq(a.waAiProcs, a.waAi * 2, 'twice the volume-derived count');
  eq(a.workers.find(w => w.name === 'export + import').count, 1, 'bulk lane still single');
});

it('fast doubles bulk and media, and triples the AI', () => {
  singleServer();
  const a = E.compute(app({ layout: 'fast', useAi: true, aiUse: 'occasional', waTransport: 'url' }));
  ok(a.workers.some(w => w.name === 'default + notification'), 'default and notification stay together');
  eq(a.workers.find(w => w.name === 'export + import').count, 2, 'two bulk processes');
  eq(a.workers.find(w => w.name === 'wa-media').count, 2, 'two media processes');
  eq(a.workers.find(w => w.name === 'wa-webhook').count, 1, 'webhook split off on its own');
  eq(a.waAiProcs, a.waAi * 3, 'three times the volume-derived count');
});

it('the AI multiplier rides on top of the volume calculation', () => {
  singleServer();
  const busy = { users: 200, intensity: 'heavy', useAi: true, aiUse: 'constant' };
  const s = E.compute(app({ ...busy, layout: 'slow' }));
  const f = E.compute(app({ ...busy, layout: 'fast' }));
  eq(s.waAi, f.waAi, 'the volume-derived base is the same either way');
  eq(f.waAiProcs, s.waAiProcs * 3, 'only the multiplier differs');
});

it('the multiplier cannot conjure processes out of a disabled assistant', () => {
  singleServer();
  eq(E.compute(app({ layout: 'fast', useAi: false })).waAiProcs, 0);
});


it('slow < default < fast for the same app', () => {
  singleServer();
  const base = { variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant', waBlast: 'heavy', emailBlast: 'occasional' };
  const slow = E.compute(app({ ...base, layout: 'slow' })).workerCount;
  const def  = E.compute(app({ ...base, layout: 'default' })).workerCount;
  const fast = E.compute(app({ ...base, layout: 'fast' })).workerCount;
  ok(slow < def, `slow ${slow} should be under default ${def}`);
  ok(def < fast, `default ${def} should be under fast ${fast}`);
});

it('Service variant runs two redis-subscribe bridges', () => {
  singleServer();
  const svc = E.compute(app({ variant: 'service', useAi: true }));
  const bridge = svc.workers.find(w => w.name.includes('bridge'));
  eq(bridge.count, 2);
});

it('custom queues add exactly the processes requested', () => {
  singleServer();
  const without = E.compute(app({})).workerCount;
  const withCustom = E.compute(app({ custom: [
    { name: 'stock-sync', procs: 2, weight: 'heavy' },
    { name: 'edi-push', procs: 1, weight: 'light' },
  ] }));
  eq(withCustom.workerCount, without + 3, 'worker count');
  const heavy = withCustom.workers.find(w => w.name.startsWith('stock-sync'));
  eq(heavy.type, 'heavy', 'weight carried through to the process type');
  eq(heavy.count * E.K.proc[heavy.type], 200, 'two heavy processes cost 200 MB');
});

it('custom queues with zero processes are ignored', () => {
  singleServer();
  const a = E.compute(app({ custom: [{ name: 'x', procs: 0, weight: 'light' }] }));
  ok(!a.workers.some(w => w.name.startsWith('x')), 'zero-process queue must not appear');
});

/* ═══════════════════════════════════════════════════════════ */
group('WhatsApp off means no WhatsApp anything');

it('the whole inbound pipeline disappears with the switch', () => {
  singleServer();
  const off = E.compute(app({ variant: 'crm', users: 60, intensity: 'heavy', useAi: false }));
  for (const name of ['wa-webhook', 'wa-media', 'wa-ai', 'bridge']) {
    ok(!off.workers.some(w => w.name.includes(name)), `${name} must not be running`);
  }
});

it('turning it on brings the pipeline back', () => {
  singleServer();
  const base = { variant: 'crm', users: 60, intensity: 'heavy', layout: 'fast' };
  const off = E.compute(app({ ...base, useAi: false }));
  const on = E.compute(app({ ...base, useAi: true, aiUse: 'regular' }));
  ok(on.workerCount > off.workerCount, `${off.workerCount} → ${on.workerCount} workers`);
  ok(on.workers.some(w => w.name.includes('bridge')), 'bridge is back');
  ok(on.ramFloor > off.ramFloor, 'and it costs memory');
});

it('outbound campaigns are independent of the assistant', () => {
  singleServer();
  const a = E.compute(app({ variant: 'crm', useAi: false, waBlast: 'heavy' }));
  ok(a.workers.some(w => w.name.includes('wa-blast')), 'blast still runs without the AI assistant');
});

/* ═══════════════════════════════════════════════════════════ */
group('Mobile app — a separate grant on the same backend');

it('nobody has mobile by default', () => {
  singleServer();
  const a = E.compute(app({ users: 60 }));
  eq(a.mobileUsers, 0);
  eq(a.mobileRps, 0, 'no API traffic');
  eq(a.mobileRowsDay, 0, 'no sync rows');
});

it('mobile users can never exceed the licensed headcount', () => {
  singleServer();
  eq(E.compute(app({ users: 20, mobileUsers: 200 })).mobileUsers, 20, 'clamped to the licence');
  eq(E.compute(app({ users: 20, mobileUsers: 8 })).mobileUsers, 8, 'a subset stays a subset');
});

it('phones generate their own API traffic on top of the web', () => {
  singleServer();
  const web = E.compute(app({ users: 60, intensity: 'moderate' }));
  const both = E.compute(app({ users: 60, intensity: 'moderate', mobileUsers: 30 }));
  eq(both.peakRps, web.peakRps, 'web traffic is unchanged');
  ok(both.mobileRps > 0, 'API traffic appears');
  near(both.mobileRps, 30 * E.INTENSITY.moderate.ratio * E.K.mobileRpm.moderate / 60, 0.001);
});

it('a phone asks more often than a person clicks', () => {
  singleServer();
  const a = E.compute(app({ users: 60, intensity: 'moderate', mobileUsers: 60 }));
  ok(a.mobileRps > a.peakRps, `same headcount, more calls: ${a.peakRps.toFixed(2)} web vs ${a.mobileRps.toFixed(2)} api`);
});

it('but each call is cheaper, so it holds a slot for less time', () => {
  ok(E.K.mobileResp < E.K.respTime, 'faster to answer');
  ok(E.K.mobileCpuReq < E.K.cpuReq, 'and cheaper in CPU');
});

it('mobile traffic is sized into the same php-fpm pool', () => {
  singleServer();
  const base = { users: 200, intensity: 'heavy' };
  const web = E.compute(app(base));
  const both = E.compute(app({ ...base, mobileUsers: 200 }));
  near(both.concurrency, both.peakRps * E.K.respTime + both.mobileRps * E.K.mobileResp, 0.001);
  ok(both.fpm > web.fpm, `phones need more children: ${web.fpm} → ${both.fpm}`);
});

it('mobile costs CPU and disk as well as slots', () => {
  singleServer();
  const base = { users: 60, intensity: 'heavy' };
  const web = E.compute(app(base));
  const both = E.compute(app({ ...base, mobileUsers: 60 }));
  ok(both.cpuPeak > web.cpuPeak, 'API calls burn CPU');
  eq(both.mobileRowsDay, 60 * E.K.mobileRowsDay, 'sync logs and push receipts');
  ok(both.dbDisk >= web.dbDisk, 'which grows the database');
});

it('the throughput panel separates pages from API calls', () => {
  singleServer(8, 16, 500);
  E.setApps([{ ...app({ name: 'A', users: 60, intensity: 'moderate', mobileUsers: 40 }), id: 1 }]);
  const t = E.throughput(E.snapshot());
  ok(t.webRps > 0 && t.mobRps > 0, 'both streams reported');
  near(t.demand, t.webRps + t.mobRps, 0.001, 'and they add up');
  ok(t.avgCpu < E.K.cpuReq, 'the blended cost drops once cheap API calls join the mix');
  ok(t.avgResp < E.K.respTime, 'and so does the blended response time');
});

/* ═══════════════════════════════════════════════════════════ */
group('Typing into the number fields');

it('a half-typed or empty field never crashes the engine', () => {
  singleServer();
  for (const raw of ['', '1', '15', '250']) {
    const a = E.compute(app({ users: raw }));
    eq(a.users, +raw || 0, `"${raw}" reads back as a number`);
    ok(a.ramEff > 0, `"${raw}" still produces a memory figure`);
    ok(a.fileDisk >= 0, `"${raw}" still produces a disk figure`);
  }
});

it('an empty field is zero, not one, and not a crash', () => {
  singleServer();
  const a = E.compute(app({ users: '' }));
  eq(a.users, 0);
  eq(a.fileDisk, 0, 'nobody means no storage quota');
});

it('custom queue process counts accept the same raw strings', () => {
  singleServer();
  const a = E.compute(app({ custom: [{ name: 'sync', procs: '3', weight: 'medium' }] }));
  const w = a.workers.find(x => x.name.startsWith('sync'));
  eq(w.count, 3, 'a string reads back as a count');
  const empty = E.compute(app({ custom: [{ name: 'sync', procs: '', weight: 'medium' }] }));
  ok(!empty.workers.some(x => x.name.startsWith('sync')), 'an empty count adds nothing');
});

/* ═══════════════════════════════════════════════════════════ */
group('WhatsApp event transport');

it('the HTTP route uses a queue worker and no resident subscriber', () => {
  singleServer();
  const a = E.compute(app({ variant: 'sales', useAi: true, waTransport: 'url', layout: 'fast' }));
  ok(a.workers.some(w => w.name.includes('wa-webhook')), 'wa-webhook queue is running');
  ok(!a.workers.some(w => w.name.includes('bridge')), 'no redis-subscribe process');
});

it('the Redis route uses a resident subscriber and no webhook queue', () => {
  singleServer();
  const a = E.compute(app({ variant: 'sales', useAi: true, waTransport: 'redis', layout: 'fast' }));
  ok(!a.workers.some(w => w.name.includes('wa-webhook')), 'no wa-webhook queue');
  ok(a.workers.some(w => w.name.includes('bridge')), 'redis-subscribe is running');
});

it('media is fetched either way', () => {
  singleServer();
  for (const tr of ['url', 'redis']) {
    const a = E.compute(app({ variant: 'sales', useAi: true, waTransport: tr, layout: 'fast' }));
    ok(a.workers.some(w => w.name.includes('wa-media')), `${tr}: wa-media must still run`);
  }
});

it('Service gets two subscribers on the Redis route, one per device', () => {
  singleServer();
  const a = E.compute(app({ variant: 'service', useAi: true, waTransport: 'redis' }));
  eq(a.workers.find(w => w.name.includes('bridge')).count, 2);
});

it('neither route runs when WhatsApp is switched off', () => {
  singleServer();
  for (const tr of ['url', 'redis']) {
    const a = E.compute(app({ useAi: false, waTransport: tr }));
    ok(!a.workers.some(w => w.name.includes('wa-')), `${tr}: nothing WhatsApp-related`);
    ok(!a.workers.some(w => w.name.includes('bridge')), `${tr}: no subscriber`);
  }
});

/* ═══════════════════════════════════════════════════════════ */
group('php-fpm pool mode');

it('a shared pool charges a fraction of the peak children', () => {
  singleServer();
  const base = { variant: 'sales', users: 40, intensity: 'moderate' };
  const ded = E.compute(app({ ...base, fpmMode: 'dedicated' }));
  const shr = E.compute(app({ ...base, fpmMode: 'shared' }));
  eq(ded.fpmCharged, ded.fpm, 'a dedicated pool reserves everything');
  eq(shr.fpmCharged, Math.max(1, Math.ceil(shr.fpm * E.K.fpmShareFactor)), 'a shared pool is oversubscribed');
  ok(shr.fpmCharged < ded.fpmCharged, `${shr.fpmCharged} < ${ded.fpmCharged}`);
  ok(shr.ramEff < ded.ramEff, 'so it costs less memory');
});

it('a shared pool never drops below one child', () => {
  singleServer();
  const a = E.compute(app({ variant: 'core', users: 5, intensity: 'light', fpmMode: 'shared' }));
  ok(a.fpmCharged >= 1);
});

/* ═══════════════════════════════════════════════════════════ */
group('Memory model');

it('idle memory = workers + scheduler, peak adds php-fpm', () => {
  singleServer();
  const a = E.compute(app({ variant: 'sales', users: 15, intensity: 'moderate', layout: 'default' }));
  const workerMb = a.workers.reduce((s, w) => s + w.count * E.K.proc[w.type], 0);
  eq(a.ramFloor, workerMb + E.K.proc.scheduler, 'floor');
  eq(a.ramPeak, a.ramFloor + a.fpmCharged * E.K.proc.fpm, 'peak');
});

it('charged memory sits between idle and peak, at the diversity factor', () => {
  singleServer();
  const a = E.compute(app({}));
  ok(a.ramEff > a.ramFloor && a.ramEff < a.ramPeak, 'must be between the two');
  near(a.ramEff, a.ramFloor + (a.ramPeak - a.ramFloor) * E.K.D, 0.01, 'diversity applied');
});

it('more users never reduces memory', () => {
  singleServer();
  let prev = 0;
  for (const u of [5, 15, 40, 100, 200]) {
    const m = E.compute(app({ users: u, intensity: 'moderate' })).ramEff;
    ok(m >= prev, `users=${u} gave ${m}, less than previous ${prev}`);
    prev = m;
  }
});

/* ═══════════════════════════════════════════════════════════ */
group('Capacity — net of system and reserve');

it('net RAM = installed − services − PostgreSQL cache − reserve', () => {
  singleServer(8, 16, 500);
  const c = E.capacity('single');
  eq(c.ramTotal, 16384);
  near(c.ramNet, c.ramTotal - c.ramSys - c.sb - c.ramReserve, 0.01, 'net RAM');
});

it('reserve scales with the hardware actually entered', () => {
  singleServer(8, 16, 500);
  const small = E.capacity('single');
  singleServer(16, 64, 2000);
  const big = E.capacity('single');
  ok(big.ramReserve > small.ramReserve, `64 GB should reserve more than 16 GB: ${small.ramReserve} vs ${big.ramReserve}`);
  ok(big.cpuReserve > small.cpuReserve, 'more cores, more reserved');
  ok(big.diskReserve > small.diskReserve, 'more disk, more reserved');
});

it('reserve is floored so a tiny box still gets something back', () => {
  singleServer(1, 1, 20);
  const R = E.reserveFor('single');
  eq(R.ram, E.RESERVE.standard.ramMin, '15% of 1 GB is below the floor');
  eq(R.cpu, E.RESERVE.standard.cpuMin);
  eq(R.disk, E.RESERVE.standard.diskMin);
});

it('reserve is capped so a huge box does not hold back absurd amounts', () => {
  singleServer(64, 512, 20000);
  const R = E.reserveFor('single');
  eq(R.ram, E.RESERVE.standard.ramMax, '15% of 512 GB is way over the cap');
  eq(R.cpu, E.RESERVE.standard.cpuMax);
  eq(R.disk, E.RESERVE.standard.diskMax);
});

it('tight < standard < roomy', () => {
  singleServer(8, 16, 500);
  const net = r => { E.S.reserve = r; return E.capacity('single').ramNet; };
  ok(net('tight') > net('standard'), 'tight leaves more usable');
  ok(net('standard') > net('roomy'), 'roomy leaves least usable');
  E.S.reserve = 'standard';
});

it('never returns a negative capacity on undersized hardware', () => {
  singleServer(1, 1, 40);
  const c = E.capacity('single');
  ok(c.ramNet >= 0 && c.cpuNet >= 0 && c.diskNet >= 0, 'all dimensions clamp at zero');
});

/* ═══════════════════════════════════════════════════════════ */
group('Disk model');

it('code disk = releases kept × release size + logs', () => {
  singleServer();
  const expected = Math.ceil((E.K.releaseMb * E.K.releasesKept) / 1024 + E.K.logGb);
  eq(E.compute(app({ users: 20 })).codeDisk, expected);
});

it('the web machine always carries code and releases', () => {
  singleServer();
  const a = E.compute(app({ users: 20 }));
  eq(a.use.single.disk, a.codeDisk + a.fileDisk + a.dbDisk, 'single server carries all three');
});

it('app server disk is never zero, even when MinIO holds the files', () => {
  clusterServers();
  const a = E.compute(app({ users: 20 }));
  eq(a.use.app.disk, a.codeDisk, 'code and releases still live on the app server');
  eq(a.use.storage.disk, 20, 'file quota goes to MinIO');
  eq(a.use.db.disk, a.dbDisk, 'database size goes to the database server');
});

it('direct file storage moves the quota onto the app server', () => {
  clusterServers();
  E.S.storage = 'direct';
  const a = E.compute(app({ users: 20 }));
  eq(a.use.app.disk, a.codeDisk + 20, 'quota lands on the app server');
  eq(E.roles().length, 2, 'no storage server exists in this mode');
  E.S.storage = 'minio';
});

it('database size is derived from rows written, not from the tier', () => {
  singleServer();
  const a = E.compute(app({ users: 60, intensity: 'heavy', useAi: false }));
  eq(a.userRowsDay, 60 * E.K.rowsPerUserDay.heavy, 'rows a day from users');
  eq(a.waRowsDay, 0, 'no AI, no WhatsApp rows');
  const expected = Math.ceil(E.K.dbSeedGb + a.rowsDay * E.K.retentionDays * E.K.rowKb / 1024 / 1024);
  eq(a.dbDisk, expected);
});

it('the AI assistant adds its own row volume to the database', () => {
  singleServer();
  const base = { users: 60, intensity: 'heavy' };
  const without = E.compute(app({ ...base, useAi: false }));
  const withAi = E.compute(app({ ...base, useAi: true, aiUse: 'constant' }));
  eq(withAi.waRowsDay, Math.round(withAi.waMsgDay * E.K.waRowsPerMsg));
  ok(withAi.dbDisk > without.dbDisk, `AI should grow the database: ${without.dbDisk} → ${withAi.dbDisk} GB`);
});

it('a five-user light app has a small but non-zero database', () => {
  singleServer();
  const a = E.compute(app({ variant: 'core', users: 5, intensity: 'light', useAi: false }));
  ok(a.dbDisk >= E.K.dbSeedGb, 'never below the seed size');
  ok(a.dbDisk < 5, `should stay small, got ${a.dbDisk} GB`);
});

it('shared_buffers is not charged twice — only per-database overhead is', () => {
  singleServer();
  const small = E.compute(app({ users: 5, intensity: 'light' }));
  const big = E.compute(app({ users: 200, intensity: 'heavy', useAi: true, aiUse: 'constant' }));
  eq(small.dbHot, E.K.dbPerAppMb, 'catalogue and relcache only');
  eq(big.dbHot, E.K.dbPerAppMb, 'a huge database does not get its own buffer pool');
  eq(small.dbRam, small.dbConn * E.K.connMb + E.K.dbPerAppMb, 'connections plus overhead');
  const c = E.capacity('single');
  ok(c.sb > 0, 'the shared pool is instead taken off the server total, once');
});

it('file quota is one gigabyte per user', () => {
  singleServer();
  eq(E.compute(app({ users: 5 })).fileDisk, 5);
  eq(E.compute(app({ users: 250 })).fileDisk, 250);
});

/* ═══════════════════════════════════════════════════════════ */
group('PostgreSQL connections');

it('the default is what PostgreSQL actually ships with, not a derived number', () => {
  singleServer(8, 16, 500);
  eq(E.maxConn(), 100, 'untouched postgresql.conf means 100');
  singleServer(64, 256, 2000);
  eq(E.maxConn(), 100, 'a huge machine still ships with 100 until someone edits the config');
});

it('superuser slots are subtracted from what apps can use', () => {
  singleServer(8, 16, 500);
  eq(E.usableConn(), 100 - E.K.connReserved);
});

it('the safe upper bound is advice, derived from database RAM', () => {
  singleServer(8, 16, 500);
  eq(E.safeMaxConn(), Math.floor(16384 * E.K.connRamPct / E.K.connMb), '16 GB');
  singleServer(8, 2, 500);
  eq(E.safeMaxConn(), 100, 'never advises going below the shipped default');
  singleServer(8, 256, 500);
  eq(E.safeMaxConn(), 500, 'caps at 500 — beyond that you want a pooler, not a bigger number');
});

it('an explicit override wins over the default', () => {
  singleServer(8, 16, 500);
  E.S.maxConn = 300;
  eq(E.maxConn(), 300);
  eq(E.usableConn(), 300 - E.K.connReserved);
  E.S.maxConn = null;
});

/* how many CRM apps fit before the connection ceiling is hit */
function appsBeforeConnLimit() {
  const one = app({ variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' });
  const per = E.compute(one).dbConn;
  return { per, fits: Math.floor(E.usableConn() / per) };
}

it('the shipped default runs out after only a few unpooled apps', () => {
  singleServer(8, 16, 500);
  E.S.pooling = 'none';
  const { per, fits } = appsBeforeConnLimit();
  ok(fits <= 6, `only ${fits} CRM apps fit at ${per} connections each — that is the whole problem`);
  E.S.pooling = 'pgbouncer';
});

it('pooling stretches the same ceiling by an order of magnitude', () => {
  singleServer(8, 16, 500);
  E.S.pooling = 'none';
  const direct = appsBeforeConnLimit();
  E.S.pooling = 'pgbouncer';
  const pool = appsBeforeConnLimit();
  eq(pool.per, E.K.poolSize, 'each app gets a fixed pool');
  ok(pool.fits >= direct.fits * 3,
     `pooled should fit far more: ${direct.fits} direct (${direct.per} conns each) vs ${pool.fits} pooled (${pool.per} each)`);
});

it('PgBouncer gives each app a fixed pool regardless of PHP process count', () => {
  singleServer();
  E.S.pooling = 'pgbouncer';
  const small = E.compute(app({ users: 5, intensity: 'light' }));
  const big = E.compute(app({ variant: 'crm', users: 200, intensity: 'heavy', layout: 'fast', useAi: true, aiUse: 'constant' }));
  eq(small.dbConn, E.K.poolSize);
  eq(big.dbConn, E.K.poolSize, 'pool size does not grow with the app');
  ok(big.phpProcs > small.phpProcs * 2,
     `the big app should dwarf the small one: ${small.phpProcs} vs ${big.phpProcs} PHP processes`);
});

it('direct connect scales connections with PHP processes', () => {
  singleServer();
  E.S.pooling = 'none';
  const a = E.compute(app({ variant: 'crm', users: 60, intensity: 'heavy', layout: 'fast', useAi: true, aiUse: 'constant' }));
  eq(a.dbConn, a.phpProcs);
  E.S.pooling = 'pgbouncer';
});

it('healthy active queries tracks four per core', () => {
  singleServer(8, 16, 500);
  eq(E.healthyActive(), 32);
});

/* ═══════════════════════════════════════════════════════════ */
group('Config values the hardware implies');

it('max_children is the lower of the memory and CPU bounds', () => {
  singleServer(8, 16, 500);
  const L = E.serverLimits();
  eq(L.maxChildren, Math.min(L.byRam, L.byCpu));
  eq(L.fpmBound, L.byRam <= L.byCpu ? 'memory' : 'CPU');
});

it('the CPU bound follows usable cores, response time and cost per request', () => {
  singleServer(8, 16, 500);
  const L = E.serverLimits();
  eq(L.byCpu, Math.round(L.web.cpuNet * E.K.respTime / E.K.cpuReq));
});

it('a CPU-poor, memory-rich box is capped by CPU', () => {
  singleServer(2, 64, 500);
  const L = E.serverLimits();
  eq(L.fpmBound, 'CPU', `memory allowed ${L.byRam}, CPU allowed ${L.byCpu}`);
});

it('a memory-poor, CPU-rich box is capped by memory', () => {
  singleServer(32, 4, 500);
  const L = E.serverLimits();
  eq(L.fpmBound, 'memory', `memory allowed ${L.byRam}, CPU allowed ${L.byCpu}`);
});

it('max_children is never zero, however small the machine', () => {
  singleServer(1, 2, 60);
  ok(E.serverLimits().maxChildren >= 1);
});

it('pooling reports how many app databases the connection budget holds', () => {
  singleServer(8, 16, 500);
  E.S.pooling = 'pgbouncer';
  const L = E.serverLimits();
  eq(L.appDbs, Math.floor(E.usableConn() / E.K.poolSize));
  ok(L.appDbs > 10, `should be roomy, got ${L.appDbs}`);
});

it('without pooling there is no fixed pool figure to report', () => {
  singleServer(8, 16, 500);
  E.S.pooling = 'none';
  eq(E.serverLimits().appDbs, null);
  E.S.pooling = 'pgbouncer';
});

it('Redis slots exclude the reserved databases', () => {
  singleServer(8, 16, 500);
  eq(E.serverLimits().redisSlots, E.S.redisDb - E.K.redisRsv);
});

it('in a cluster the figures come from the right machine each time', () => {
  clusterServers();
  E.servers.app.cores = 16;
  E.servers.db.cores = 2;
  const L = E.serverLimits();
  eq(L.web.label, 'App Server', 'php-fpm sizing reads the app server');
  eq(L.db.label, 'Database Server', 'connection sizing reads the database server');
  eq(L.healthy, 2 * 4, 'active-query guidance uses database cores, not app cores');
});

/* ═══════════════════════════════════════════════════════════ */
group('Recommendations for the remaining capacity');

it('an empty server offers the largest package it can actually hold', () => {
  singleServer(8, 16, 500);
  E.setApps([]);
  const r = E.recommend(E.snapshot());
  ok(r.ok, 'something must fit on an empty server');
  eq(r.biggest, r.fits[r.fits.length - 1], 'the biggest is the last of the fitting ones');
  ok(r.biggest.points <= 100, 'and it genuinely fits');
});

it('every suggestion really does fit in what is left', () => {
  singleServer(8, 16, 500);
  E.setApps([{ ...app({ name: 'A', variant: 'crm', users: 80, intensity: 'heavy', useAi: true }), id: 1 }]);
  const s = E.snapshot();
  const r = E.recommend(s);
  for (const p of r.fits) {
    ok(p.points <= s.left, `${p.name} at ${p.points.toFixed(1)} must fit in ${s.left.toFixed(1)}`);
    ok(p.howMany >= 1, `${p.name} must be placeable at least once`);
    ok(p.howMany * p.points <= s.left + 0.001, `${p.howMany}× ${p.name} must not overflow`);
  }
});

it('suggestions shrink as the server fills up', () => {
  singleServer(8, 16, 500);
  E.setApps([]);
  const empty = E.recommend(E.snapshot()).fits.length;
  E.setApps([1, 2].map(i => ({ ...app({ name: 'A' + i, variant: 'crm', users: 80, intensity: 'heavy', useAi: true }), id: i })));
  const loaded = E.recommend(E.snapshot()).fits.length;
  ok(loaded < empty, `${empty} options when empty should drop below that when loaded, got ${loaded}`);
});

it('a full server says nothing fits and names the shortfall', () => {
  singleServer(2, 4, 40);
  E.setApps([{ ...app({ name: 'A', variant: 'sales', users: 10, intensity: 'moderate' }), id: 1 }]);
  const r = E.recommend(E.snapshot());
  ok(!r.ok, 'must report that nothing fits');
  ok(r.smallest, 'and still name the cheapest package');
  ok(r.gaps.length > 0, 'and say what is missing');
  for (const g of r.gaps) {
    ok(g.short > 0, 'a gap must be a real shortfall');
    ok(['memory', 'CPU', 'disk'].includes(g.dim), 'named dimension');
    ok(typeof g.fmt(g.short) === 'string', 'formatted for display');
  }
});

it('the shortfall is ordered worst first', () => {
  singleServer(2, 4, 40);
  E.setApps([{ ...app({ name: 'A', variant: 'crm', users: 60, intensity: 'heavy', useAi: true }), id: 1 }]);
  const r = E.recommend(E.snapshot());
  if (!r.ok && r.gaps.length > 1) {
    for (let i = 1; i < r.gaps.length; i++) ok(r.gaps[i - 1].short >= r.gaps[i].short, 'sorted descending');
  }
});

it('growing the hardware turns a refusal into a suggestion', () => {
  singleServer(2, 4, 40);
  E.setApps([{ ...app({ name: 'A', variant: 'sales', users: 10, intensity: 'moderate' }), id: 1 }]);
  ok(!E.recommend(E.snapshot()).ok, 'cramped to begin with');
  E.servers.single = { cores: 8, ram: 16, disk: 500 };
  ok(E.recommend(E.snapshot()).ok, 'and roomy once the specs grow');
});

it('every catalogue profile is priced, fitting or not', () => {
  singleServer(2, 4, 40);
  E.setApps([]);
  eq(E.recommend(E.snapshot()).priced.length, E.PROFILES.length);
});

/* ═══════════════════════════════════════════════════════════ */
group('Points');

it('an empty setup is zero used and one hundred free', () => {
  singleServer();
  E.setApps([]);
  const s = E.snapshot();
  eq(s.used, 0);
  eq(s.left, 100);
});

it('the first registered app produces a sane, non-zero score', () => {
  singleServer();
  E.setApps([{ ...app({ name: 'First', variant: 'sales', users: 15, intensity: 'moderate' }), id: 1 }]);
  const s = E.snapshot();
  eq(s.computed.length, 1);
  ok(s.used > 0, 'score must not be zero');
  ok(s.used < 100, `a single Low tier app must not fill the server, got ${s.used.toFixed(1)}`);
  ok(s.computed[0].driver && s.computed[0].driver.dim, 'a limiting dimension must be identified');
  near(s.used + s.left, 100, 0.001, 'used and free must add up');
});

it('points equal the worst dimension, not the sum of them', () => {
  singleServer();
  const caps = E.roles().map(E.capacity);
  const a = E.compute(app({ variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' }));
  const p = E.pointsOf(a, caps);
  const c = caps[0];
  const dims = [a.use.single.ram / c.ramNet, a.use.single.cpu / c.cpuNet, a.use.single.disk / c.diskNet];
  near(p.points, Math.max(...dims) * 100, 0.001, 'worst dimension wins');
});

it('total used is the sum of the individual app scores', () => {
  singleServer();
  E.setApps([
    { ...app({ name: 'A', variant: 'sales', users: 15 }), id: 1 },
    { ...app({ name: 'B', variant: 'crm', users: 40, intensity: 'heavy' }), id: 2 },
  ]);
  const s = E.snapshot();
  near(s.used, s.computed[0].points + s.computed[1].points, 0.001);
});

it('a bigger server means the same app costs fewer points', () => {
  const one = app({ variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' });
  singleServer(8, 16, 500);
  const small = E.pointsOf(E.compute(one), E.roles().map(E.capacity)).points;
  singleServer(16, 64, 2000);
  const big = E.pointsOf(E.compute(one), E.roles().map(E.capacity)).points;
  ok(big < small, `expected the cost to drop on bigger hardware: ${small.toFixed(1)} → ${big.toFixed(1)}`);
});

it('free capacity never goes below zero when oversubscribed', () => {
  singleServer(2, 4, 100);
  E.setApps(Array.from({ length: 8 }, (_, i) =>
    ({ ...app({ name: 'X' + i, variant: 'crm', users: 100, intensity: 'heavy', useAi: true, aiUse: 'constant' }), id: i + 1 })));
  const s = E.snapshot();
  ok(s.used > 100, 'this really is oversubscribed');
  eq(s.left, 0, 'free capacity clamps at zero');
});

/* ═══════════════════════════════════════════════════════════ */
group('Small hardware — the 2 core / 4 GB / 40 GB case');

it('a small box still reports usable capacity in all three dimensions', () => {
  singleServer(2, 4, 40);
  const c = E.capacity('single');
  ok(c.ramNet > 0, `memory must not clamp to zero, got ${c.ramNet}`);
  ok(c.cpuNet > 0, `CPU must not clamp to zero, got ${c.cpuNet}`);
  ok(c.diskNet > 0, `disk must not clamp to zero, got ${c.diskNet}`);
  ok(c.viable, 'the machine should be flagged as usable');
});

it('one small app on a small box scores well under 100', () => {
  singleServer(2, 4, 40);
  E.setApps([{ ...app({ name: 'Tiny', variant: 'core', users: 5, intensity: 'light', useAi: false, layout: 'slow' }), id: 1 }]);
  const s = E.snapshot();
  ok(s.used < 90, `a five-user Core app must not fill a 4 GB box, got ${s.used.toFixed(1)}`);
  ok(s.used > 10, `nor should it look free, got ${s.used.toFixed(1)}`);
});

it('a box too small to run anything is flagged rather than silently scored', () => {
  singleServer(1, 1, 15);
  const c = E.capacity('single');
  ok(!c.viable, 'must be reported as not viable');
  ok(c.short.length > 0, 'and must name which dimensions ran out');
});

it('the smallest possible app is the floor every tenant costs', () => {
  singleServer(8, 16, 500);
  const tiny = E.smallestApp();
  eq(tiny.users, 5);
  eq(tiny.waAi, 0, 'no AI');
  ok(tiny.use.single.ram > 0 && tiny.use.single.disk > 0, 'still costs something');
  const normal = E.compute(app({ variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' }));
  ok(tiny.use.single.ram < normal.use.single.ram, 'and it is the cheapest thing there is');
});

/* ═══════════════════════════════════════════════════════════ */
group('Redis');

it('one database per app plus two reserved', () => {
  singleServer();
  E.setApps([1, 2, 3].map(i => ({ ...app({ name: 'A' + i }), id: i })));
  eq(E.S.redisDb, 16, 'default is the Redis default');
  eq(E.getApps().length + E.K.redisRsv, 5, 'three apps plus Bouncer and WhatsApp Service');
  eq(E.K.redisDbs - E.K.redisRsv, 14, 'fourteen slots available for apps');
});

/* ═══════════════════════════════════════════════════════════ */
group('Throughput');

it('demand is the sum of every app peak request rate', () => {
  singleServer();
  E.setApps([
    { ...app({ name: 'A', users: 20, intensity: 'moderate' }), id: 1 },
    { ...app({ name: 'B', users: 50, intensity: 'heavy' }), id: 2 },
  ]);
  const s = E.snapshot();
  const t = E.throughput(s);
  near(t.demand, s.computed[0].peakRps + s.computed[1].peakRps, 0.001);
});

it('the ceiling is the lower of the CPU limit and the slot limit', () => {
  singleServer();
  const t = E.throughput(E.snapshot());
  eq(t.ceiling, Math.min(t.byCpu, t.bySlots));
  ok(t.ceiling > 0, 'ceiling must be positive');
});

it('queue workers eat into what the web tier can serve', () => {
  singleServer();
  E.setApps([{ ...app({ variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant', layout: 'fast' }), id: 1 }]);
  const t = E.throughput(E.snapshot());
  ok(t.queueCpu > 0, 'queue workers burn CPU');
  near(t.webCpu, t.cpuNet - t.queueCpu, 0.001, 'web CPU is what is left over');
});

it('an empty server reports a bare ceiling and no ratio', () => {
  singleServer();
  E.setApps([]);
  const t = E.throughput(E.snapshot());
  eq(t.ratio, null);
  ok(t.byCpu > 0);
});

/* ═══════════════════════════════════════════════════════════ */
group('Cluster mode');

it('cluster splits the load across three machines', () => {
  clusterServers();
  E.setApps([{ ...app({ name: 'A', variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' }), id: 1 }]);
  const s = E.snapshot();
  eq(s.caps.length, 3);
  const a = s.computed[0];
  ok(a.use.app.ram > 0 && a.use.db.ram > 0 && a.use.storage.ram > 0, 'every machine carries something');
});

it('a well-matched cluster costs fewer points than one shared box', () => {
  const one = { ...app({ name: 'A', variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' }), id: 1 };
  singleServer(8, 16, 500);
  E.setApps([one]);
  const single = E.snapshot().used;
  clusterServers();
  E.servers.db.disk = 800;   // sized for databases, not left at the single-box figure
  const cluster = E.snapshot().used;
  ok(cluster < single, `cluster ${cluster.toFixed(1)} should beat single ${single.toFixed(1)}`);
});

it('an undersized machine in a cluster drags the whole score down', () => {
  // the cluster below has far more total hardware than one 8-core box, yet a cramped
  // database disk still makes it the bottleneck — the score must surface that, not hide it
  const one = { ...app({ name: 'A', variant: 'crm', users: 60, intensity: 'heavy', useAi: true, aiUse: 'constant' }), id: 1 };
  clusterServers();
  E.servers.db.disk = 300;
  E.setApps([one]);
  const s = E.snapshot();
  eq(s.computed[0].driver.server, 'Database Server', 'the cramped machine is named');
  eq(s.computed[0].driver.dim, 'Disk', 'and so is the cramped dimension');

  E.servers.db.disk = 800;
  const relieved = E.snapshot();
  ok(relieved.used < s.used, 'growing that one disk lowers the score');
});

/* ═══════════════════════════════════════════════════════════ */
group('Editing an app');

it('replacing an app in place keeps the identifier and updates the score', () => {
  singleServer();
  const original = { ...app({ name: 'A', users: 15, intensity: 'moderate' }), id: 7 };
  E.setApps([original]);
  const before = E.snapshot().used;
  E.setApps([{ ...original, users: 120, intensity: 'heavy' }]);
  const after = E.snapshot();
  eq(after.computed.length, 1, 'still one app');
  eq(after.computed[0].id, 7, 'identifier survives the edit');
  ok(after.used > before, `score should climb: ${before.toFixed(1)} → ${after.used.toFixed(1)}`);
});

/* ── report ────────────────────────────────────────────────── */
console.log('\nSolaris Capacity Calculator — engine tests\n' + '─'.repeat(62));
for (const [tag, name, msg] of results) {
  if (tag === '##') console.log('\n' + name);
  else if (tag) console.log(`${tag}  ${name}${msg ? '\n        → ' + msg : ''}`);
}
console.log('─'.repeat(62));
console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
