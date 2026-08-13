/* ═══════════════════════════════════════════════════════════
 CONSTANTS — every assumption lives here
 ═══════════════════════════════════════════════════════════ */
const K = {
proc:      { light: 50, medium: 60, heavy: 100, bridge: 55, scheduler: 50, fpm: 50 },  // MB
waAiSec:   18,      // average seconds per wa-ai job
waAiUtil:  0.5,     // target utilisation of a wa-ai worker
respTime:  0.30,    // average response time, seconds
fpmUtil:   0.5,     // target utilisation of php-fpm
cpuReq:    0.10,    // core-seconds per web request

/* The mobile app is a REST client against the same Laravel. Each call is cheaper —
   JSON out, no Blade rendering — but a phone asks far more often than a person clicks. */
mobileResp:   0.15, // seconds for an API call
mobileCpuReq: 0.05, // core-seconds for an API call
mobileRpm:    { light: 2, moderate: 6, heavy: 15 }, // calls a minute while the app is open
mobileRowsDay: 20,  // sync log, device token and push receipt rows per mobile user

cpuWorker: 0.005,   // cores per idle worker
cpuSched:  0.017,   // cores per app for schedule:run every minute
cpuWaAi:   0.05,    // cores per active wa-ai worker
D:         0.7,     // diversity — share of apps assumed to peak together
diskUser:  1,       // GB of file storage sold per user

/* code on disk — one deployed release plus the ones kept for rollback */
releaseMb:    400,  // MB for a single release: app code + vendor + built assets
releasesKept: 5,    // releases retained for zero-downtime deploy and rollback
logGb:        1,    // GB of application logs

/* database growth */
rowKb:        2,    // average row on disk including its indexes
retentionDays: 1095, // three years before anything is archived
rowsPerUserDay: { light: 20, moderate: 80, heavy: 250 },
waRowsPerMsg: 3,    // message + delivery log + AI trace
waActiveHours: 9,   // hours a day the team is actually working
aiTurns: 4,         // user turns in one assistant conversation, each triggering a reply
aiPeakFactor: 2,    // the busiest hour carries about twice the flat average
dbSeedGb:     2,    // empty schema, master data, indexes
/* shared_buffers is one pool for the whole instance and is already taken off the server
   total, so a database costs only its own catalogue and relation cache on top */
dbPerAppMb:   40,   // MB of catalogue and relcache per database
fpmShareFactor: 0.3, // a shared pool is oversubscribed: apps rarely peak together
fpmRamShare: 0.4,    // share of usable memory the web tier may claim at peak
pgbMaxClient: 2000,  // PgBouncer client slots — about 2 KB each, so effectively free

sysDisk:   12,      // GB for OS, packages and system logs
minioRam:  300,     // MB base
connDefault: 100,   // PostgreSQL ships with max_connections = 100
connReserved: 3,    // superuser_reserved_connections, unavailable to apps
connMb:    5,       // MB per idle PostgreSQL connection
connRamPct: 0.15,   // share of database RAM it is safe to hand to connections
poolSize:  5,       // PgBouncer server connections per app database
redisDbs:  16,      // Redis databases available (Redis default)
redisRsv:  2,       // reserved for Bouncer and WhatsApp Service
};

/* Reserve scales with the machine, then gets floored and capped so that neither a
 tiny box loses everything nor a huge box holds back more than a deploy could ever use. */
const RESERVE = {
tight:    { label: 'Tight',    pct: 0.08, ramMin: 384, ramMax: 2048,  cpuMin: 0.25, cpuMax: 1, diskMin: 6,  diskMax: 100,
            desc: 'Bare minimum. A deploy will briefly compete with live traffic.' },
standard: { label: 'Standard', pct: 0.15, ramMin: 512, ramMax: 6144,  cpuMin: 0.40, cpuMax: 2, diskMin: 10, diskMax: 250,
            desc: 'Room for a deploy, a seeder run and a backup at the same time.' },
roomy:    { label: 'Roomy',    pct: 0.25, ramMin: 768, ramMax: 12288, cpuMin: 0.60, cpuMax: 4, diskMin: 16, diskMax: 500,
            desc: 'Comfortable. Big imports and restores never touch the live apps.' },
};

/* what this reserve level works out to on the hardware actually entered */
function reserveFor(role) {
const s = servers[role] || {};
const R = RESERVE[S.reserve];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
return {
  ram:  clamp((s.ram || 0) * 1024 * R.pct, R.ramMin, R.ramMax),
  cpu:  clamp((s.cores || 0) * R.pct, R.cpuMin, R.cpuMax),
  disk: clamp((s.disk || 0) * R.pct, R.diskMin, R.diskMax),
};
}

const INTENSITY = {
light:    { label: 'Light',    weight: 1,   ratio: 0.15, rpm: 1, note: 'Dips in now and then — dashboards, approvals, reports.' },
moderate: { label: 'Moderate', weight: 2.5, ratio: 0.30, rpm: 3, note: 'In the app half the day — entering opportunities, following up.' },
heavy:    { label: 'Heavy',    weight: 5,   ratio: 0.50, rpm: 8, note: 'In the app all day — handling chats, keying in orders.' },
};

const VARIANTS = {
core:      { label: 'Core',      bridges: 1, blast: false },
lite:      { label: 'Lite',      bridges: 1, blast: false },
sales:     { label: 'Sales',     bridges: 1, blast: false },
marketing: { label: 'Marketing', bridges: 1, blast: true  },
service:   { label: 'Service',   bridges: 2, blast: false },
crm:       { label: 'CRM',       bridges: 2, blast: true  },
};

/* The layout is the responsiveness dial. It alone decides the process plan — the tier does not
 touch it, so Slow and Default are never the same shape.
   batchOwn    batch-delete gets its own lane instead of sharing with default + notification
   ioProcs     processes on the export + import lane
   mediaProcs  processes fetching WhatsApp media
   webhookOwn  wa-webhook split off from wa-media
   waAi        multiplier on the volume-derived wa-ai count */
const LAYOUTS = {
slow: {
  label: 'Slow', batchOwn: false, ioProcs: 1, mediaProcs: 1, webhookOwn: false, waAi: 1,
  note: 'Everything shares as few lanes as possible. A bulk delete can hold up notifications. Cheapest to run.',
},
default: {
  label: 'Default', batchOwn: true, ioProcs: 1, mediaProcs: 1, webhookOwn: false, waAi: 2,
  note: 'Bulk deletes get their own lane so the progress bar keeps moving, and the AI answers two chats at once.',
},
fast: {
  label: 'Fast', batchOwn: true, ioProcs: 2, mediaProcs: 2, webhookOwn: true, waAi: 3,
  note: 'Exports and media run two at a time, the AI three, and webhooks never queue behind a download.',
},
};

/* The WhatsApp assistant serves the team, not customers — staff message it to look things
 up and file records. Volume follows headcount, and people work in bursts: they open a
 conversation and fire several questions at once, rather than trickling messages all day. */
const AI_USE = {
occasional: { label: 'Occasional', share: 0.2, sessions: 2,  note: 'A few people check figures over chat once or twice a day.' },
regular:    { label: 'Regular',    share: 0.5, sessions: 6,  note: 'Half the team reaches for it several times a day.' },
constant:   { label: 'Constant',   share: 0.8, sessions: 12, note: 'Field staff work almost entirely through WhatsApp.' },
};

const BLAST = {
none:       { label: 'Not used',   workers: 0, note: 'No sending processes reserved.' },
occasional: { label: 'Occasional', workers: 1, note: 'A campaign now and then.' },
heavy:      { label: 'Heavy',      workers: 2, note: 'Frequent campaigns, big recipient lists.' },
};

/* How Bouncer hands incoming WhatsApp events to Solaris. The two routes cost different processes. */
const WA_TRANSPORT = {
url:   { label: 'HTTP webhook',   note: 'Bouncer posts each event to a URL. Picked up by the wa-webhook queue, so it shares the queue machinery and survives restarts.' },
redis: { label: 'Redis subscribe', note: 'A resident process listens on Redis. No HTTP hop and lower latency, but the process is always running whether messages arrive or not.' },
};

const FPM_MODE = {
shared:    { label: 'Shared pool',    note: 'Sits in one php-fpm pool with the other apps. Cheapest, but a slow app can starve its neighbours.' },
dedicated: { label: 'Dedicated pool', note: 'Its own pool, own system user, own child limit. Isolated and predictable, costs more memory.' },
};

const WEIGHT = {
light:  { label: 'Light',  note: 'Short jobs, small payloads' },
medium: { label: 'Medium', note: 'File handling, broadcasts' },
heavy:  { label: 'Heavy',  note: 'Bulk processing, can hit the memory limit' },
};

const TIER = {
low:    { label: 'Low',    fpmFloor: 3,  cls: 'bg-ok/10 text-ok' },
medium: { label: 'Medium', fpmFloor: 6,  cls: 'bg-warn/10 text-warn' },
high:   { label: 'High',   fpmFloor: 12, cls: 'bg-danger/10 text-danger' },
};

const DEPLOY = {
single:  { label: 'Single Server', desc: 'Everything on one machine — app, database and files. Simplest to run and to bill.' },
cluster: { label: 'Cluster',       desc: 'App, database and storage on separate machines. Costs more, scales much further.' },
};

const SERVICES = [
{ key: 'pooling', title: 'Database connection pooling', opts: {
    pgbouncer: { label: 'Use PgBouncer', desc: 'Each app database gets a small fixed pool of real connections.' },
    none:      { label: 'Direct connect', desc: 'Every PHP process holds its own connection straight to PostgreSQL.' },
}},
{ key: 'storage', title: 'Where uploaded files live', opts: {
    minio:  { label: 'Use MinIO',   desc: 'Object storage service. Needed once app servers scale out.' },
    direct: { label: 'Direct file', desc: 'Files written straight to local disk. No extra service to run.' },
}},
];

const SUGGEST = {
single:  { cores: 8, ram: 16, disk: 500 },
app:     { cores: 8, ram: 16, disk: 200 },
db:      { cores: 4, ram: 16, disk: 300 },
storage: { cores: 2, ram: 4,  disk: 2000 },
};

/* ═══════════════════════════════════════════════════════════
 STATE — starts empty
 ═══════════════════════════════════════════════════════════ */
const S = {
stage: 1,
deploy: null,
storage: 'minio',
pooling: 'pgbouncer',
reserve: 'standard',
redisDb: K.redisDbs,
maxConn: null,        // null = auto-derived from hardware
touched: {},
};

const servers = {
single:  { cores: null, ram: null, disk: null },
app:     { cores: null, ram: null, disk: null },
db:      { cores: null, ram: null, disk: null },
storage: { cores: null, ram: null, disk: null },
};

let apps = [];
let seq = 1;
let editingId = null;
const open = new Set();

const blankForm = () => ({
name: '', variant: 'sales', users: 15, mobileUsers: 0, intensity: 'moderate',
useAi: false, aiUse: 'regular', waTransport: 'redis', layout: 'default', fpmMode: 'shared',
waBlast: 'none', emailBlast: 'none', custom: [],
});
let form = blankForm();

const pooled = () => S.pooling === 'pgbouncer';
const roles = () => S.deploy === 'single' ? ['single']
                : S.storage === 'minio' ? ['app', 'db', 'storage'] : ['app', 'db'];
const webRole = () => S.deploy === 'single' ? 'single' : 'app';
const dbRole  = () => S.deploy === 'single' ? 'single' : 'db';

function roleBase(role) {
const minio = S.storage === 'minio';
const pb = pooled() ? 30 : 0;
switch (role) {
  case 'single':  return { ram: 395 + pb + (minio ? K.minioRam : 0), cpu: 0.5 + (minio ? 0.15 : 0), sbPct: 0.15,
                           label: 'Server',
                           note: ['OS', 'nginx', 'Reverb', 'Bouncer', 'PostgreSQL', pooled() ? 'PgBouncer' : null, 'Redis', minio ? 'MinIO' : null].filter(Boolean).join(', ') };
  case 'app':     return { ram: 325, cpu: 0.3, sbPct: 0, label: 'App Server', note: 'OS, nginx, Reverb, Bouncer' };
  case 'db':      return { ram: 320 + pb, cpu: 0.3, sbPct: 0.25, label: 'Database Server',
                           note: ['OS', 'PostgreSQL', pooled() ? 'PgBouncer' : null, 'Redis'].filter(Boolean).join(', ') };
  case 'storage': return { ram: 250 + K.minioRam, cpu: 0.2, sbPct: 0, label: 'Storage Server', note: 'OS, MinIO' };
}
}

const specsFilled = () => roles().every(r => ['cores', 'ram', 'disk'].every(k => servers[r][k] > 0));

/* What the machine actually has: PostgreSQL ships with 100 and stays there unless
 postgresql.conf is edited and the service restarted. */
const maxConn = () => S.maxConn ?? K.connDefault;
const usableConn = () => Math.max(0, maxConn() - K.connReserved);

/* How far it could safely be raised. Each idle backend is a process costing about 5 MB,
 so memory is the ceiling — but raising it buys parked connections, not throughput. */
function safeMaxConn() {
const ramMb = (servers[dbRole()].ram || 0) * 1024;
return Math.max(K.connDefault, Math.min(500, Math.floor(ramMb * K.connRamPct / K.connMb)));
}

/* PostgreSQL stops gaining throughput past roughly 4 active queries per core */
const healthyActive = () => (servers[dbRole()].cores || 0) * 4;

/* ═══════════════════════════════════════════════════════════
 CALCULATION ENGINE
 ═══════════════════════════════════════════════════════════ */
function tierOf(users, intensity) {
const score = users * INTENSITY[intensity].weight;
return { score, tier: score <= 50 ? 'low' : score <= 200 ? 'medium' : 'high' };
}

function blastCount(level, layout) {
const base = BLAST[level].workers;
if (!base) return 0;
if (layout === 'slow') return 1;              // one lane no matter what
if (layout === 'fast') return base * 3;       // send / schedule / webhook split
return base;
}

function buildWorkers(cfg, v, tier, waAi) {
const w = [];
const add = (name, type, count = 1) => { if (count > 0) w.push({ name, type, count }); };
const L = cfg.layout;
const P = LAYOUTS[L] || LAYOUTS.default;
/* no WhatsApp integration means no inbound pipeline at all — not the webhook,
   the media fetcher, the AI, nor the device bridge */
const wa = !!cfg.useAi;
/* an HTTP webhook is drained by a queue worker; Redis instead needs a resident subscriber */
const viaUrl = wa && cfg.waTransport === 'url';

/* interactive lane — batch-delete blocks the UI, so it moves out first */
if (P.batchOwn) {
  add('default + notification', 'light');
  add('batch-delete', 'medium');
} else {
  add('default + notification + batch-delete', 'medium');
}

/* bulk lane — nobody is watching, but it is heavy, so it never shares */
add('export + import', 'heavy', P.ioProcs);

/* WhatsApp inbound */
if (wa) {
  if (P.webhookOwn) {
    if (viaUrl) add('wa-webhook', 'medium');
    add('wa-media', 'medium', P.mediaProcs);
  } else if (viaUrl) {
    add('wa-webhook + wa-media', 'medium', P.mediaProcs);
  } else {
    add('wa-media', 'medium', P.mediaProcs);
  }
}

if (v.blast) {
  const split = L === 'fast';
  add(split ? 'wa-blast (send / schedule / webhook)' : 'wa-blast group', 'light', blastCount(cfg.waBlast, L));
  add(split ? 'email-blast (send / schedule / webhook)' : 'email-blast group', 'light', blastCount(cfg.emailBlast, L));
}

/* the volume-derived count, multiplied by how responsive the layout should be */
add('wa-ai', 'medium', waAi * P.waAi);
/* the resident subscriber exists only on the Redis route */
if (wa && !viaUrl) add('bridge redis-subscribe', 'bridge', v.bridges);

(cfg.custom || []).forEach(c => add((c.name || 'custom queue') + ' *', c.weight || 'light', +c.procs || 0));
return w;
}

function compute(cfg) {
const v = VARIANTS[cfg.variant];
const it = INTENSITY[cfg.intensity];
const users = Math.max(0, +cfg.users || 0);
const { score, tier } = tierOf(users, cfg.intensity);
const T = TIER[tier];

const peakRps = users * it.ratio * it.rpm / 60;

/* mobile is a separate grant: only the people who were given access hit the REST API */
const mobileUsers = Math.min(users, Math.max(0, +cfg.mobileUsers || 0));
const mobileRps = mobileUsers * it.ratio * K.mobileRpm[cfg.intensity] / 60;

/* Assistant traffic comes from the team, in bursts.
   people → conversations a day → turns per conversation → messages a day,
   then flattened over the working day and doubled for the busiest hour. */
const ai = AI_USE[cfg.aiUse] || AI_USE.regular;
const aiUsers = cfg.useAi ? Math.max(1, Math.round(users * ai.share)) : 0;
const aiSessionsDay = aiUsers * ai.sessions;
const waMsgDay = aiSessionsDay * K.aiTurns;
const waMsgHour = waMsgDay / K.waActiveHours * K.aiPeakFactor;
const waAi = waMsgHour > 0 ? Math.max(1, Math.ceil((waMsgHour * K.waAiSec / 3600) / K.waAiUtil)) : 0;

const workers = buildWorkers(cfg, v, tier, waAi);
const workerCount = workers.reduce((s, w) => s + w.count, 0);
const waAiProcs = (workers.find(w => w.name === 'wa-ai') || {}).count || 0;
const workerMb = workers.reduce((s, w) => s + w.count * K.proc[w.type], 0);
/* both traffic types occupy the same php-fpm children, so size against their combined
   concurrency: requests per second × how long each holds a slot */
const concurrency = peakRps * K.respTime + mobileRps * K.mobileResp;
const fpm = Math.max(T.fpmFloor, Math.ceil(concurrency / K.fpmUtil));
/* a shared pool is sized once for everyone and oversubscribed, so an app only
   carries the children it is actually expected to occupy at the same time */
const shared = cfg.fpmMode === 'shared';
const fpmCharged = shared ? Math.max(1, Math.ceil(fpm * K.fpmShareFactor)) : fpm;

const ramFloor = workerMb + K.proc.scheduler;
const ramPeak = ramFloor + fpmCharged * K.proc.fpm;
const ramEff = ramFloor + (ramPeak - ramFloor) * K.D;

const cpuFloor = workerCount * K.cpuWorker + K.cpuSched;
const cpuPeak = cpuFloor + peakRps * K.cpuReq + mobileRps * K.mobileCpuReq + waAi * K.cpuWaAi;
const cpuEff = cpuFloor + (cpuPeak - cpuFloor) * K.D;

const phpProcs = workerCount + fpmCharged;
const dbConn = pooled() ? K.poolSize : phpProcs;
const dbCpu = peakRps * 0.05 + workerCount * 0.002;

/* disk — every figure below is derived, nothing is a magic number */

// code: one release is app + vendor + built assets; several are kept for rollback
const codeDisk = Math.ceil((K.releaseMb * K.releasesKept) / 1024 + K.logGb);

// files: the quota sold to the customer, one gigabyte a head
const fileDisk = users * K.diskUser;

// database: rows written per day × how long they are kept × bytes on disk
const mobileRowsDay = mobileUsers * K.mobileRowsDay;   // sync logs and push receipts
const userRowsDay = users * K.rowsPerUserDay[cfg.intensity] + mobileRowsDay;
const waRowsDay = Math.round(waMsgDay * K.waRowsPerMsg);   // daily total, not the peak hour
const rowsDay = userRowsDay + waRowsDay;
const dbGrowthGb = rowsDay * K.retentionDays * K.rowKb / 1024 / 1024;
const dbDisk = Math.ceil(K.dbSeedGb + dbGrowthGb);

// shared_buffers is already reserved server-wide, so only per-database overhead is charged here
const dbHot = K.dbPerAppMb;
const dbRam = dbConn * K.connMb + dbHot;

const minio = S.storage === 'minio';

const use = {
  single:  { ram: ramEff + 9 + dbRam + 40 + (minio ? 20 : 0), cpu: cpuEff + dbCpu + 0.01, disk: codeDisk + fileDisk + dbDisk },
  app:     { ram: ramEff + 9, cpu: cpuEff, disk: codeDisk + (minio ? 0 : fileDisk) },
  db:      { ram: dbRam + 20, cpu: dbCpu, disk: dbDisk },
  storage: { ram: 20, cpu: 0.01, disk: fileDisk },
};

return { ...cfg, users, mobileUsers, mobileRps, mobileRowsDay, concurrency,
         tier, score, peakRps, waAi, waAiProcs, aiUsers, aiSessionsDay, waMsgDay, waMsgHour, workers, workerCount, fpm, fpmCharged, shared,
         ramFloor, ramPeak, ramEff, cpuFloor, cpuPeak, cpuEff,
         phpProcs, dbConn, dbRam, dbHot, dbCpu, fileDisk, dbDisk, codeDisk,
         userRowsDay, waRowsDay, rowsDay, use };
}

function capacity(role) {
const s = servers[role];
const b = roleBase(role);
const R = reserveFor(role);
const cores = s.cores || 0, disk = s.disk || 0;
const ramTotal = (s.ram || 0) * 1024;
const sb = ramTotal * b.sbPct;

const ramNet = ramTotal - b.ram - sb - R.ram;
const cpuNet = cores - b.cpu - R.cpu;
const diskNet = disk - K.sysDisk - R.disk;

const short = [];
if (ramNet <= 0) short.push('memory');
if (cpuNet <= 0) short.push('CPU');
if (diskNet <= 0) short.push('disk');

return {
  role, label: b.label, note: b.note, short, viable: short.length === 0,
  ramTotal, ramSys: b.ram, sb, ramReserve: R.ram, ramNet: Math.max(0, ramNet),
  cpuTotal: cores, cpuSys: b.cpu, cpuReserve: R.cpu, cpuNet: Math.max(0, cpuNet),
  diskTotal: disk, diskSys: K.sysDisk, diskReserve: R.disk, diskNet: Math.max(0, diskNet),
};
}

/* Realistic packages to measure the remaining capacity against, cheapest first in spirit.
 Used to answer "what could I still sell into this server" rather than an abstract number. */
const PROFILES = [
{ name: 'Lite · 5 users',       variant: 'lite',      users: 5,   intensity: 'light',    useAi: false, layout: 'slow' },
{ name: 'Lite · 15 users',      variant: 'lite',      users: 15,  intensity: 'moderate', useAi: false, layout: 'slow' },
{ name: 'Sales · 10 users',     variant: 'sales',     users: 10,  intensity: 'moderate', useAi: false, layout: 'slow' },
{ name: 'Sales · 25 users',     variant: 'sales',     users: 25,  intensity: 'moderate', useAi: false, layout: 'default' },
{ name: 'Sales · 25 + AI',      variant: 'sales',     users: 25,  intensity: 'moderate', useAi: true,  aiUse: 'regular', layout: 'default' },
{ name: 'Service · 30 users',   variant: 'service',   users: 30,  intensity: 'heavy',    useAi: true,  aiUse: 'regular', layout: 'default' },
{ name: 'Marketing · 30 users', variant: 'marketing', users: 30,  intensity: 'moderate', useAi: false, layout: 'default', waBlast: 'occasional', emailBlast: 'occasional' },
{ name: 'CRM · 40 users',       variant: 'crm',       users: 40,  intensity: 'moderate', useAi: true,  aiUse: 'regular',  layout: 'default', waBlast: 'occasional', emailBlast: 'occasional' },
{ name: 'CRM · 80 users',       variant: 'crm',       users: 80,  intensity: 'heavy',    useAi: true,  aiUse: 'regular',  layout: 'default', waBlast: 'occasional', emailBlast: 'occasional' },
{ name: 'CRM · 150 users',      variant: 'crm',       users: 150, intensity: 'heavy',    useAi: true,  aiUse: 'constant', layout: 'fast',    waBlast: 'heavy',      emailBlast: 'heavy' },
];

/* What could still be placed on this server, and if nothing can, exactly why not. */
function recommend(snap) {
const priced = PROFILES.map(p => {
  const a = compute({ ...blankForm(), ...p });
  const { points, driver } = pointsOf(a, snap.caps);
  return { ...p, app: a, points, driver, howMany: points > 0 ? Math.floor(snap.left / points) : 0 };
}).sort((x, y) => x.points - y.points);

const fits = priced.filter(p => p.howMany >= 1);
if (fits.length) {
  const biggest = fits[fits.length - 1];
  const cheapest = fits[0];
  return { ok: true, priced, fits, biggest, cheapest };
}

/* nothing fits — work out what the smallest package is still short of */
const smallest = priced[0];
const gaps = snap.caps.map(c => {
  const u = smallest.app.use[c.role];
  const used = d => snap.computed.reduce((s, a) => s + a.use[c.role][d], 0);
  return [
    { server: c.label, dim: 'memory', short: u.ram - (c.ramNet - used('ram')), unit: 'MB', fmt: gb },
    { server: c.label, dim: 'CPU', short: u.cpu - (c.cpuNet - used('cpu')), unit: 'cores', fmt: v => v.toFixed(2) + ' cores' },
    { server: c.label, dim: 'disk', short: u.disk - (c.diskNet - used('disk')), unit: 'GB', fmt: v => Math.ceil(v) + ' GB' },
  ];
}).flat().filter(g => g.short > 0).sort((a, b) => b.short - a.short);

return { ok: false, priced, smallest, gaps };
}

/* Configuration values that follow from the hardware alone, before any app is registered.
 These are the numbers that go straight into pool.d/*.conf, postgresql.conf and pgbouncer.ini. */
function serverLimits() {
const web = capacity(webRole());
const db = capacity(dbRole());

/* php-fpm children are bounded twice over: by memory, and by the CPU that can
   actually retire the requests those children accept. The lower one wins. */
const byRam = Math.floor(web.ramNet * K.fpmRamShare / K.proc.fpm);
const byCpu = Math.round(web.cpuNet * K.respTime / K.cpuReq);
const maxChildren = Math.max(1, Math.min(byRam, byCpu));

const conn = usableConn();
const appDbs = pooled() ? Math.floor(conn / K.poolSize) : null;

return {
  web, db, byRam, byCpu, maxChildren,
  fpmBound: byRam <= byCpu ? 'memory' : 'CPU',
  perChild: K.proc.fpm,
  maxConn: maxConn(), usableConn: conn, healthy: healthyActive(),
  poolSize: K.poolSize, maxClient: K.pgbMaxClient, appDbs,
  redisSlots: Math.max(0, S.redisDb - K.redisRsv),
};
}

/* the cheapest app Solaris can run — used to tell whether a machine is worth deploying to at all */
const smallestApp = () => compute({ ...blankForm(), variant: 'core', users: 5, intensity: 'light', useAi: false, layout: 'slow' });

/* one app's cost as a share of the whole setup, in points out of 100 */
function pointsOf(a, caps) {
let worst = 0, driver = null;
for (const c of caps) {
  const u = a.use[c.role];
  for (const x of [
    { d: 'RAM',  v: c.ramNet  > 0 ? u.ram  / c.ramNet  : 1 },
    { d: 'CPU',  v: c.cpuNet  > 0 ? u.cpu  / c.cpuNet  : 1 },
    { d: 'Disk', v: c.diskNet > 0 ? u.disk / c.diskNet : 1 },
  ]) {
    if (x.v > worst) { worst = x.v; driver = { server: c.label, dim: x.d }; }
  }
}
return { points: worst * 100, driver };
}

function snapshot() {
const caps = roles().map(capacity);
const computed = apps.map(compute).map(a => ({ ...a, ...pointsOf(a, caps) }));
const used = computed.reduce((s, a) => s + a.points, 0);
return { caps, computed, used, left: Math.max(0, 100 - used) };
}

/* how many requests per second the web tier can serve, versus how many it is asked for */
function throughput(snap) {
const cap = snap.caps.find(c => c.role === webRole());
const webRps = snap.computed.reduce((s, a) => s + a.peakRps, 0);
const mobRps = snap.computed.reduce((s, a) => s + a.mobileRps, 0);
const demand = webRps + mobRps;
const queueCpu = snap.computed.reduce((s, a) => s + a.cpuFloor + a.waAi * K.cpuWaAi, 0);
const webCpu = Math.max(0, cap.cpuNet - queueCpu);

/* an API call is cheaper than a page, so the ceiling depends on the actual mix */
const avgCpu = demand > 0 ? (webRps * K.cpuReq + mobRps * K.mobileCpuReq) / demand : K.cpuReq;
const avgResp = demand > 0 ? (webRps * K.respTime + mobRps * K.mobileResp) / demand : K.respTime;

const byCpu = webCpu / avgCpu;
const slots = snap.computed.reduce((s, a) => s + a.fpm, 0);
const bySlots = slots > 0 ? slots / avgResp : Infinity;
const ceiling = Math.min(byCpu, bySlots);

/* translate into something a person can picture: page loads a minute, and how many
   more people of the kind already on this server it could carry */
const totalUsers = snap.computed.reduce((s, a) => s + a.users, 0);
const rpsPerUser = totalUsers > 0 ? demand / totalUsers
  : INTENSITY.moderate.ratio * INTENSITY.moderate.rpm / 60;
const spareUsers = rpsPerUser > 0 ? Math.floor((ceiling - demand) / rpsPerUser) : 0;

return { demand, webRps, mobRps, avgCpu, avgResp, byCpu, bySlots, ceiling, slots, queueCpu, webCpu, cpuNet: cap.cpuNet,
         totalUsers, spareUsers,
         mobileUsers: snap.computed.reduce((s, a) => s + a.mobileUsers, 0),
         demandMin: demand * 60, ceilingMin: ceiling * 60,
         webMin: webRps * 60, mobMin: mobRps * 60,
         limiter: byCpu <= bySlots ? 'CPU' : 'PHP-FPM slots',
         ratio: demand > 0 ? ceiling / demand : null };
}

/* ═══════════════════════════════════════════════════════════
 HELPERS
 ═══════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gb = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
const pct = (a, b) => b > 0 ? Math.min(100, a / b * 100) : 0;
const tone = p => p >= 90 ? 'bg-danger' : p >= 70 ? 'bg-warn' : 'bg-ok';
const toneTxt = p => p >= 90 ? 'text-danger' : p >= 70 ? 'text-warn' : 'text-ok';
/* js-chev marks the disclosure arrow — the row also holds edit and delete icons,
 so the toggle handler must target this one by class, never by position */
const chev = k => `<svg class="js-chev w-4 h-4 text-faint transition-transform shrink-0" style="${open.has(k) ? 'transform:rotate(180deg)' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const opts = (obj, sel, fn) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === String(sel) ? ' selected' : ''}>${fn(v)}</option>`).join('');

function radioCard(on, action, label, desc) {
return `<button ${action} class="text-left rounded-xl border-2 p-4 transition ${
  on ? 'border-primary bg-primary-50' : 'border-line bg-white hover:border-primary-200'}">
  <div class="flex items-center gap-2.5 mb-1.5">
    <span class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${on ? 'border-primary' : 'border-line'}">
      ${on ? '<span class="w-2 h-2 rounded-full bg-primary"></span>' : ''}
    </span>
    <span class="text-[13px] font-semibold">${label}</span>
  </div>
  <p class="text-xs text-muted leading-relaxed" style="padding-left:1.625rem">${desc}</p>
</button>`;
}

/* ═══════════════════════════════════════════════════════════
 WIZARD SHELL
 ═══════════════════════════════════════════════════════════ */
const STEPS = ['Server type', 'Hardware', 'Apps'];

function renderStepper() {
$('stepper').innerHTML = STEPS.map((label, i) => {
  const n = i + 1;
  const done = n < S.stage, now = n === S.stage;
  const reach = n === 1 || (n === 2 && S.deploy) || (n === 3 && specsFilled());
  return `
    ${i ? `<div class="flex-1 h-px mx-3 ${done ? 'bg-primary' : 'bg-line'}"></div>` : ''}
    <button data-goto="${n}" ${reach ? '' : 'disabled'} class="flex items-center gap-2.5 ${reach ? '' : 'opacity-40 cursor-not-allowed'}">
      <span class="w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center shrink-0 transition ${
        done ? 'bg-primary text-white' : now ? 'bg-primary text-white ring-4 ring-primary/15' : 'bg-shell text-faint border border-line'}">
        ${done ? '&check;' : n}
      </span>
      <span class="text-[13px] ${now ? 'font-semibold' : 'text-muted'}">${label}</span>
    </button>`;
}).join('');
}

function goto(n) {
if (n === 2 && !S.deploy) return;
if (n === 3 && !specsFilled()) return;
S.stage = n;
[1, 2, 3].forEach(i => $('stage' + i).classList.toggle('hidden', i !== n));
renderAll();
window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════════════
 STAGE 1 & 2
 ═══════════════════════════════════════════════════════════ */
function renderStage1() {
$('deployPick').innerHTML = Object.entries(DEPLOY)
  .map(([k, v]) => radioCard(S.deploy === k, `data-set="deploy:${k}"`, v.label, v.desc)).join('');
$('next1').disabled = !S.deploy;
}

function renderStage2() {
const r = roles();
$('serverCards').className = 'grid gap-4 ' + (r.length === 1 ? 'max-w-sm' : r.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3');
$('serverCards').innerHTML = r.map(role => {
  const b = roleBase(role), s = servers[role], g = SUGGEST[role];
  const inp = (key, label) => `<div><label class="lbl">${label}</label>
    <input type="number" min="1" value="${s[key] ?? ''}" placeholder="${g[key]}" data-srv="${role}" data-key="${key}" class="field num-input"></div>`;
  return `
    <div class="bg-white rounded-xl border border-line shadow-card p-5">
      <div class="mb-4">
        <h3 class="text-[13px] font-semibold">${b.label}</h3>
        <p class="text-xs text-muted mt-0.5 leading-relaxed">${b.note}</p>
      </div>
      <div class="grid grid-cols-3 gap-2.5">${inp('cores', 'Cores')}${inp('ram', 'RAM GB')}${inp('disk', 'Disk GB')}</div>
    </div>`;
}).join('');

$('servicePick').innerHTML = SERVICES.map(g => `
  <div>
    <p class="text-xs font-medium text-muted mb-2">${g.title}</p>
    <div class="grid gap-4 sm:grid-cols-2">
      ${Object.entries(g.opts).map(([k, v]) => radioCard(S[g.key] === k, `data-set="${g.key}:${k}"`, v.label, v.desc)).join('')}
    </div>
  </div>`).join('');

renderReserve();
renderDefaults();
$('next2').disabled = !specsFilled();
}

/* redrawn on every spec keystroke, so the reserve always reflects the hardware entered */
function renderReserve() {
const primary = webRole();
$('reservePick').innerHTML = Object.entries(RESERVE).map(([k, v]) => {
  const was = S.reserve; S.reserve = k;
  const R = reserveFor(primary);
  S.reserve = was;
  const amount = specsFilled()
    ? `${(R.ram / 1024).toFixed(1)} GB RAM · ${R.cpu.toFixed(2)} cores · ${Math.round(R.disk)} GB disk`
    : `${v.pct * 100}% of each machine`;
  return radioCard(S.reserve === k, `data-set="reserve:${k}"`,
    `${v.label} — ${amount}`, v.desc);
}).join('');

/* a machine that cannot fit even the smallest possible app is a configuration error, not a score */
const dead = roles().map(capacity).filter(c => !c.viable);
const tiny = specsFilled() ? smallestApp() : null;
const tooTight = tiny ? roles().map(capacity).filter(c => c.viable && (
  tiny.use[c.role].ram > c.ramNet || tiny.use[c.role].cpu > c.cpuNet || tiny.use[c.role].disk > c.diskNet)) : [];

$('specWarning').innerHTML = !specsFilled() ? '' : dead.length ? `
  <div class="rounded-xl border border-danger/30 bg-danger/5 p-4 flex gap-3">
    <span class="text-danger font-bold leading-none mt-0.5">!</span>
    <div class="text-xs leading-relaxed">
      <p class="font-semibold text-danger mb-1">${dead.map(c => c.label).join(' and ')} has no room left for apps</p>
      <p class="text-danger/90">
        After system services and the reserve there is nothing left of its
        <span class="font-medium">${dead.flatMap(c => c.short).join(', ')}</span>.
        ${dead.some(c => c.short.includes('disk')) ? `Disk needs to clear ${K.sysDisk} GB of system space plus the reserve before an app can land. ` : ''}
        ${dead.some(c => c.short.includes('memory')) ? `Memory is going to ${S.storage === 'minio' ? 'MinIO, ' : ''}PostgreSQL cache and the reserve. ` : ''}
        Raise the specs, or pick a tighter reserve.
      </p>
    </div>
  </div>` : tooTight.length ? `
  <div class="rounded-xl border border-warn/30 bg-warn/5 p-4 flex gap-3">
    <span class="text-warn font-bold leading-none mt-0.5">!</span>
    <div class="text-xs leading-relaxed">
      <p class="font-semibold text-warn mb-1">Not big enough for even one app</p>
      <p class="text-warn/90">
        The smallest thing Solaris can run — Core, 5 light users, no WhatsApp AI, slow workers — already needs
        ${gb(tiny.use[tooTight[0].role].ram)} of memory and ${Math.round(tiny.use[tooTight[0].role].disk)} GB of disk
        on ${tooTight[0].label}, which only has ${gb(tooTight[0].ramNet)} and ${Math.round(tooTight[0].diskNet)} GB free.
      </p>
    </div>
  </div>` : `
  <div class="rounded-xl border border-line bg-white p-4 text-xs text-muted leading-relaxed">
    Room for the smallest possible app (Core, 5 light users, no AI, slow workers):
    <span class="font-medium text-ink">${gb(tiny.use[primary].ram)} memory</span>,
    <span class="font-medium text-ink">${tiny.use[primary].cpu.toFixed(2)} cores</span>,
    <span class="font-medium text-ink">${Math.round(tiny.use[primary].disk)} GB disk</span>
    — that is the floor any tenant costs you.
  </div>`;

renderLimitsPanel();
}

/* the config values this hardware implies, ready to paste into the real files */
function renderLimitsPanel() {
if (!specsFilled()) { $('derivedLimits').innerHTML = ''; return; }
const L = serverLimits();

const row = (k, v, hint) => `
  <div class="flex items-baseline justify-between gap-4 py-1.5 border-b border-line last:border-0">
    <div class="min-w-0">
      <span class="font-mono text-[11px] text-ink">${k}</span>
      ${hint ? `<p class="text-[10px] text-faint leading-relaxed mt-0.5">${hint}</p>` : ''}
    </div>
    <span class="text-[13px] font-semibold tabular-nums shrink-0">${v}</span>
  </div>`;

$('derivedLimits').innerHTML = `
  <div class="bg-white rounded-xl border border-line shadow-card overflow-hidden">
    <div class="px-5 py-3.5 border-b border-line bg-shell/60">
      <h3 class="text-sm font-semibold">What this hardware allows</h3>
      <p class="text-xs text-muted mt-0.5">Derived from the specs above — these are the numbers to put in the config files.</p>
    </div>
    <div class="p-5 grid gap-6 sm:grid-cols-${pooled() ? '3' : '2'}">

      <div>
        <p class="text-[11px] uppercase tracking-wide text-faint mb-2">php-fpm · ${L.web.label}</p>
        ${row('pm.max_children', L.maxChildren, `Across every pool combined, at ${L.perChild} MB a child.`)}
        ${row('limited by', L.fpmBound, `memory allows ${L.byRam}, CPU allows ${L.byCpu}`)}
        ${row('pm', L.maxChildren < 10 ? 'ondemand' : 'dynamic',
              L.maxChildren < 10 ? 'Too few slots to keep spares idling.' : 'Enough room to hold warm children.')}
        <p class="text-[10px] text-faint leading-relaxed mt-2">
          CPU bound comes from ${L.web.cpuNet.toFixed(2)} usable cores ÷ ${K.cpuReq} core-s per request
          × ${K.respTime} s each. More children than that only lengthens the queue.
        </p>
      </div>

      <div>
        <p class="text-[11px] uppercase tracking-wide text-faint mb-2">PostgreSQL · ${L.db.label}</p>
        ${row('max_connections', L.maxConn, `${K.connReserved} held for superusers, ${L.usableConn} left for apps.`)}
        ${row('healthy active queries', L.healthy, `${L.db.cpuTotal} cores × 4. Past this, throughput falls.`)}
        ${row('per idle backend', K.connMb + ' MB', 'Raising the limit raises the worst-case memory with it.')}
        ${!pooled() ? `
        <p class="text-[10px] text-warn leading-relaxed mt-2">
          Without pooling each app claims one connection per PHP process, so ${L.usableConn} slots
          run out after only a handful of apps.
        </p>` : ''}
      </div>

      ${pooled() ? `
      <div>
        <p class="text-[11px] uppercase tracking-wide text-faint mb-2">PgBouncer</p>
        ${row('default_pool_size', L.poolSize, 'Real connections per app database.')}
        ${row('max_client_conn', L.maxClient, 'Client slots are about 2 KB each — set it generously.')}
        ${row('pool_mode', 'transaction', 'Needs PgBouncer 1.21+ for PDO prepared statements.')}
        ${row('app databases that fit', L.appDbs, `${L.usableConn} ÷ ${L.poolSize} per database.`)}
      </div>` : ''}
    </div>

    <div class="px-5 py-3 border-t border-line bg-shell/40 flex flex-wrap gap-x-8 gap-y-1 text-xs">
      <span class="text-muted">Redis app slots <span class="font-semibold text-ink tabular-nums">${L.redisSlots}</span>
        <span class="text-faint">of ${S.redisDb}, ${K.redisRsv} reserved</span></span>
      <span class="text-muted">Request ceiling <span class="font-semibold text-ink tabular-nums">${(L.web.cpuNet / K.cpuReq).toFixed(0)} req/s</span>
        <span class="text-faint">before queue workers take their share</span></span>
    </div>
  </div>`;
}

function renderDefaults() {
const chip = (label, val, why) =>
  `<div class="flex items-baseline gap-1.5"><span class="text-muted">${label}</span>
   <span class="font-semibold tabular-nums">${val}</span>
   <span class="text-[10px] text-faint">${why}</span></div>`;

$('defaultsPanel').innerHTML = `
  <div class="bg-white rounded-xl border border-line shadow-card overflow-hidden">
    <button data-open="defaults" class="w-full px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-shell/50 transition text-left">
      <div class="flex flex-wrap gap-x-7 gap-y-1.5 text-xs">
        ${chip('PostgreSQL max connections', maxConn(), S.maxConn === null ? 'PostgreSQL default' : 'edited')}
        ${chip('Redis databases', S.redisDb, S.touched.redisDb ? 'edited' : 'Redis default')}
      </div>
      <span class="flex items-center gap-1.5 text-xs text-primary font-medium shrink-0">Adjust ${chev('defaults')}</span>
    </button>
    <div id="p-defaults" class="${open.has('defaults') ? '' : 'hidden'} px-5 pb-5 pt-4 border-t border-line bg-shell/40">
      <div class="grid gap-6 sm:grid-cols-2">
        <div>
          <label class="lbl">PostgreSQL max connections</label>
          <input id="maxConn" type="number" value="${maxConn()}" class="field num-input">
          <div class="text-xs text-muted mt-2 space-y-1.5 leading-relaxed">
            <p><span class="font-medium text-ink">${K.connDefault}</span> is what PostgreSQL ships with, and what the
            machine will have unless <span class="font-mono">postgresql.conf</span> is edited and the service restarted.
            ${K.connReserved} are held for superusers, leaving
            <span class="font-medium text-ink">${usableConn()}</span> for apps.</p>
            <p>It <em>can</em> be raised — memory is the ceiling, since each idle backend is a process costing about ${K.connMb} MB:</p>
            <div class="font-mono text-[11px] bg-white rounded-lg border border-line p-2.5 text-faint">
              ${(servers[dbRole()].ram || 0)} GB × ${K.connRamPct * 100}% ÷ ${K.connMb} MB = ${safeMaxConn()} safe upper bound
            </div>
            <p>But raising it buys parked connections, not speed. PostgreSQL stops gaining throughput past roughly
            four <em>active</em> queries per core — about <span class="font-medium text-ink">${healthyActive()}</span> here —
            and <span class="font-mono">work_mem</span> is charged per sort, so a higher ceiling also raises the worst-case
            memory blow-up. Pooling is the real fix; direct connect has nothing holding it back.</p>
          </div>
        </div>
        <div>
          <label class="lbl">Redis databases</label>
          <input id="redisDb" type="number" value="${S.redisDb}" class="field num-input">
          <div class="text-xs text-muted mt-2 space-y-1.5 leading-relaxed">
            <p>Redis ships with 16 and needs a config change plus a restart to raise. One database per app,
            holding both its queues and its cache.</p>
            <p>${K.redisRsv} are already taken by Bouncer and WhatsApp Service, leaving
            <span class="font-medium text-ink">${Math.max(0, S.redisDb - K.redisRsv)}</span> for apps.</p>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════
 STAGE 3
 ═══════════════════════════════════════════════════════════ */
function renderScore(snap) {
const { caps, computed, used, left } = snap;

const rec = recommend(snap);

const detail = caps.map(c => {
  const u = d => computed.reduce((s, a) => s + a.use[c.role][d], 0);
  const line = (name, val, net, fmt) => {
    const q = pct(val, net);
    return `<div class="py-1.5">
      <div class="flex justify-between text-[11px] mb-1">
        <span class="text-muted">${name}</span>
        <span class="tabular-nums ${q >= 90 ? 'text-danger font-semibold' : 'text-muted'}">${fmt(val)} / ${fmt(net)}</span>
      </div>
      <div class="h-1 rounded-full track overflow-hidden"><div class="h-full ${tone(q)} rounded-full" style="width:${q}%"></div></div>
    </div>`;
  };
  return `
    <div class="rounded-lg border border-line p-3.5 bg-white">
      <p class="text-[11px] font-semibold mb-1">${c.label}</p>
      ${line('Memory', u('ram'), c.ramNet, gb)}
      ${line('CPU', u('cpu'), c.cpuNet, v => v.toFixed(2) + ' cores')}
      ${line('Disk', u('disk'), c.diskNet, v => Math.round(v) + ' GB')}
      <div class="mt-2.5 pt-2.5 border-t border-line space-y-1 text-[10px] text-faint">
        <div class="flex justify-between"><span>RAM installed</span><span>${gb(c.ramTotal)}</span></div>
        <div class="flex justify-between"><span>− system services</span><span>${gb(c.ramSys)}</span></div>
        ${c.sb > 0 ? `<div class="flex justify-between"><span>− PostgreSQL cache</span><span>${gb(c.sb)}</span></div>` : ''}
        <div class="flex justify-between"><span>− breathing room</span><span>${gb(c.ramReserve)}</span></div>
        <div class="flex justify-between font-semibold text-muted"><span>usable for apps</span><span>${gb(c.ramNet)}</span></div>
      </div>
    </div>`;
}).join('');

$('scorePanel').innerHTML = `
  <section class="bg-white rounded-xl border border-line shadow-card overflow-hidden">
    <div class="p-6">
      <div class="flex flex-wrap items-end gap-x-10 gap-y-4 mb-5">
        <div>
          <p class="text-xs text-muted mb-1.5">Capacity used</p>
          <div class="flex items-baseline gap-2">
            <span class="text-5xl font-bold tabular-nums ${used >= 90 ? 'text-danger' : used >= 70 ? 'text-warn' : 'text-primary'} leading-none">${used.toFixed(1)}</span>
            <span class="text-xl text-faint tabular-nums leading-none">/ 100</span>
          </div>
        </div>
        <div class="pb-1">
          <p class="text-xs text-muted mb-1">Still free</p>
          <p class="text-2xl font-semibold tabular-nums ${apps.length ? toneTxt(used) : 'text-ok'} leading-none">${left.toFixed(1)} <span class="text-sm font-normal text-faint">points</span></p>
        </div>
      </div>

      ${rec.ok ? `
      <div class="rounded-xl border border-ok/25 bg-ok/5 p-4 mb-5">
        <p class="text-xs font-semibold text-ok mb-2.5">Still room for</p>
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-3">
          <span class="text-[15px] font-semibold">${rec.biggest.name}</span>
          <span class="text-xs text-muted">is the largest package that still fits — ${rec.biggest.points.toFixed(1)} points,
            leaving ${(left - rec.biggest.points).toFixed(1)} after it.</span>
        </div>
        <div class="grid gap-1.5 sm:grid-cols-2">
          ${rec.fits.slice().reverse().slice(0, 6).map(p => `
            <div class="flex items-baseline justify-between gap-3 text-xs py-1 px-2.5 rounded-lg bg-white border border-line">
              <span class="truncate">${p.name}</span>
              <span class="shrink-0 tabular-nums">
                <span class="font-semibold">${p.howMany}×</span>
                <span class="text-faint">· ${p.points.toFixed(1)} pts each</span>
              </span>
            </div>`).join('')}
        </div>
        ${rec.cheapest.howMany > 1 ? `<p class="text-xs text-muted mt-3">
          Or pack it with small tenants: up to <span class="font-semibold text-ink">${rec.cheapest.howMany} × ${rec.cheapest.name}</span>.
        </p>` : ''}
      </div>` : `
      <div class="rounded-xl border border-danger/25 bg-danger/5 p-4 mb-5">
        <p class="text-xs font-semibold text-danger mb-2">Nothing more fits</p>
        <p class="text-xs text-danger/90 leading-relaxed mb-3">
          Even the smallest package, <span class="font-medium">${rec.smallest.name}</span>, needs
          ${rec.smallest.points.toFixed(1)} points and only ${left.toFixed(1)} are free.
        </p>
        ${rec.gaps.length ? `
        <p class="text-xs font-medium text-danger mb-1.5">To make it fit, add at least:</p>
        <div class="space-y-1">
          ${rec.gaps.slice(0, 3).map(g => `
            <div class="flex items-baseline justify-between gap-3 text-xs py-1 px-2.5 rounded-lg bg-white border border-danger/20">
              <span class="text-muted">${g.server} · ${g.dim}</span>
              <span class="font-semibold tabular-nums text-danger">+ ${g.fmt(g.short)}</span>
            </div>`).join('')}
        </div>` : `
        <p class="text-xs text-danger/90">Free up capacity by removing an app, or move one to another cluster.</p>`}
      </div>`}

      <div class="h-3 rounded-full track overflow-hidden flex">
        ${computed.map((a, i) => `<div class="h-full ${used >= 90 ? 'bg-danger' : 'bg-primary'} ${i ? 'border-l border-white/70' : ''}"
           style="width:${Math.min(100, a.points)}%" title="${esc(a.name)} · ${a.points.toFixed(1)} pts"></div>`).join('')}
      </div>
      <div class="flex justify-between mt-2 text-xs text-faint">
        <span>${apps.length} app${apps.length === 1 ? '' : 's'} registered</span>
        <span>${used >= 100 ? 'Over capacity — this setup will not hold' : 'Breathing room already excluded'}</span>
      </div>

      ${(() => {
        const dead = caps.filter(c => !c.viable);
        if (dead.length) {
          return `<div class="mt-4 flex gap-2.5 text-xs bg-danger/8 border border-danger/25 rounded-lg p-3">
            <span class="text-danger font-bold leading-none mt-0.5">!</span>
            <p class="text-danger/90 leading-relaxed">
              <span class="font-medium">${dead.map(c => c.label).join(' and ')} has zero usable ${dead.flatMap(c => c.short).join(' and ')}.</span>
              Every app therefore reads as fully consuming the server. Go back and raise the specs —
              the scores below are meaningless until that is fixed.
            </p></div>`;
        }
        if (!computed.length) return '';
        const worst = computed.reduce((m, a) => a.points > m.points ? a : m, computed[0]);
        const tally = {};
        computed.forEach(a => { const k = `${a.driver.dim} on ${a.driver.server}`; tally[k] = (tally[k] || 0) + a.points; });
        const top = Object.entries(tally).sort((x, y) => y[1] - x[1])[0];
        return `<p class="mt-4 text-xs text-muted leading-relaxed">
          Most of the load lands on <span class="font-medium text-ink">${top[0]}</span> —
          ${top[1].toFixed(1)} of the ${used.toFixed(1)} points used.
          The heaviest single app is <span class="font-medium text-ink">${esc(worst.name)}</span> at ${worst.points.toFixed(1)}.
          Growing that one resource is what buys you room.
        </p>`;
      })()}

      ${used >= 90 && caps.every(c => c.viable) ? `
      <div class="mt-4 flex gap-2.5 text-xs bg-danger/8 border border-danger/25 rounded-lg p-3">
        <span class="text-danger font-bold leading-none mt-0.5">!</span>
        <p class="text-danger/90 leading-relaxed">Past 90%. The reserve is being eaten into — a deploy or a backup can now stall the live apps.</p>
      </div>` : ''}
    </div>

    <button data-open="cap" class="w-full px-6 py-3 border-t border-line bg-shell/50 hover:bg-shell text-left transition flex items-center justify-between">
      <span class="text-xs font-medium text-muted">Where the points go</span>${chev('cap')}
    </button>
    <div id="p-cap" class="${open.has('cap') ? '' : 'hidden'} p-6 pt-5 bg-shell/50 border-t border-line">
      <div class="grid gap-3 ${caps.length === 1 ? 'max-w-xs' : caps.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}">${detail}</div>
      <p class="text-[11px] text-faint mt-4 leading-relaxed">
        An app's point cost is set by whichever bar it fills fastest — memory, CPU or disk, on whichever machine.
        That is the resource that runs out first, so that is what gets charged.
      </p>
    </div>
  </section>`;

$('stickyScore').innerHTML = (S.stage === 3 && apps.length) ? `
  <div class="text-right">
    <div class="text-[11px] text-faint leading-none">capacity used</div>
    <div class="text-[13px] font-semibold tabular-nums leading-tight ${toneTxt(used)}">${used.toFixed(1)} / 100</div>
  </div>
  <div class="w-24 h-1.5 rounded-full track overflow-hidden">
    <div class="h-full ${tone(used)} rounded-full transition-all" style="width:${Math.min(100, used)}%"></div>
  </div>` : '';
}

const ICON_EDIT = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICON_TRASH = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>`;

function renderTable(snap) {
$('appCount').textContent = apps.length ? `(${apps.length})` : '';
$('emptyState').classList.toggle('hidden', apps.length > 0);

$('appBody').innerHTML = snap.computed.map(a => {
  const T = TIER[a.tier];
  const rows = a.workers.map(w =>
    `<div class="flex justify-between gap-4 py-0.5">
       <span class="font-mono text-[11px] text-muted">${esc(w.name)}${w.count > 1 ? ` ×${w.count}` : ''}</span>
       <span class="text-[11px] text-faint">${w.count * K.proc[w.type]} MB</span>
     </div>`).join('');

  const shares = snap.caps.map(c => {
    const u = a.use[c.role];
    const line = (n, dim, key, netKey) => {
      const hot = a.driver && a.driver.server === c.label && a.driver.dim === dim;
      return `<div class="flex justify-between text-[11px] ${hot ? 'font-semibold text-ink' : 'text-muted'}">
        <span>${n}</span><span class="tabular-nums">${pct(u[key], c[netKey]).toFixed(1)} pts</span></div>`;
    };
    return `<div class="mb-2.5">
      <p class="text-[10px] uppercase tracking-wide text-faint mb-1">${c.label}</p>
      ${line('Memory', 'RAM', 'ram', 'ramNet')}${line('CPU', 'CPU', 'cpu', 'cpuNet')}${line('Disk', 'Disk', 'disk', 'diskNet')}
    </div>`;
  }).join('');

  const bits = [
    VARIANTS[a.variant].label,
    a.users + ' users' + (a.mobileUsers > 0 ? ` (${a.mobileUsers} mobile)` : ''),
    INTENSITY[a.intensity].label,
    a.useAi ? `AI assistant ${AI_USE[a.aiUse].label.toLowerCase()} via ${WA_TRANSPORT[a.waTransport].label.toLowerCase()}` : 'no AI assistant',
    LAYOUTS[a.layout].label + ' workers',
  ];
  if (VARIANTS[a.variant].blast) bits.push(`WA blast ${BLAST[a.waBlast].label.toLowerCase()}`, `email blast ${BLAST[a.emailBlast].label.toLowerCase()}`);
  if (a.custom && a.custom.length) bits.push(`${a.custom.reduce((s, c) => s + (+c.procs || 0), 0)} custom`);

  return `
    <tr class="border-b border-line hover:bg-shell/50 transition cursor-pointer" data-open="app${a.id}">
      <td class="px-5 py-3">
        <div class="font-medium">${esc(a.name)}</div>
        <div class="text-xs text-muted mt-0.5">${bits.join(' · ')}</div>
      </td>
      <td class="px-3 py-3"><span class="text-xs font-medium px-2 py-1 rounded-md ${T.cls}">${T.label}</span></td>
      <td class="px-3 py-3 text-right">
        <div class="text-lg font-bold tabular-nums text-primary leading-none">${a.points.toFixed(1)}</div>
        <div class="text-[11px] text-faint mt-1">${a.driver ? a.driver.dim + ' bound' : ''}</div>
      </td>
      <td class="px-3 py-3">
        <div class="flex items-center justify-end gap-0.5">
          <button data-edit="${a.id}" class="icon-btn" title="Edit">${ICON_EDIT}</button>
          <button data-del="${a.id}" class="icon-btn danger" title="Remove">${ICON_TRASH}</button>
          ${chev('app' + a.id)}
        </div>
      </td>
    </tr>
    <tr id="p-app${a.id}" class="${open.has('app' + a.id) ? '' : 'hidden'} bg-shell/40">
      <td colspan="4" class="px-5 py-5">
        <div class="grid gap-6 sm:grid-cols-3">
          <div>
            <p class="text-xs font-semibold mb-2.5">Point breakdown</p>
            ${shares}
            <p class="text-[10px] text-faint leading-relaxed">Highest number wins — that is the app's score.</p>
          </div>
          <div>
            <p class="text-xs font-semibold mb-2.5">Worker processes <span class="text-faint font-normal">(${a.workerCount})</span></p>
            ${rows}
            <div class="flex justify-between gap-4 py-0.5">
              <span class="font-mono text-[11px] text-muted">scheduler</span><span class="text-[11px] text-faint">${K.proc.scheduler} MB</span>
            </div>
            <div class="flex justify-between gap-4 py-0.5 mt-1 pt-1 border-t border-line">
              <span class="font-mono text-[11px] text-muted">php-fpm ×${a.fpmCharged}${a.shared ? ` <span class="text-faint">(${a.fpm} at peak, shared pool)</span>` : ''}</span><span class="text-[11px] text-faint">${a.fpmCharged * K.proc.fpm} MB</span>
            </div>
            ${a.custom && a.custom.length ? `<p class="text-[10px] text-faint mt-2">* custom queue</p>` : ''}
          </div>
          <div>
            <p class="text-xs font-semibold mb-2.5">Details</p>
            <div class="space-y-1 text-[11px] text-muted">
              <div class="flex justify-between"><span>Usage score</span><span>${a.score.toFixed(0)} → ${T.label}</span></div>
              <div class="flex justify-between"><span>Memory idle</span><span>${gb(a.ramFloor)}</span></div>
              <div class="flex justify-between"><span>Memory at peak</span><span>${gb(a.ramPeak)}</span></div>
              <div class="flex justify-between font-medium text-ink"><span>Memory charged</span><span>${gb(a.ramEff)}</span></div>
              <div class="flex justify-between"><span>Web page loads</span><span>${(a.peakRps * 60).toFixed(0)}/min peak</span></div>
              <div class="flex justify-between"><span>Mobile API calls</span><span>${a.mobileUsers > 0 ? (a.mobileRps * 60).toFixed(0) + '/min peak' : '—'}</span></div>
              <div class="flex justify-between"><span>Slots held at once</span><span>${a.concurrency.toFixed(2)}</span></div>
              <div class="flex justify-between"><span>AI assistant users</span><span>${a.useAi ? `${a.aiUsers} of ${a.users}` : '—'}</span></div>
              <div class="flex justify-between"><span>Conversations</span><span>${a.useAi ? a.aiSessionsDay.toLocaleString() + '/day' : '—'}</span></div>
              <div class="flex justify-between"><span>Assistant messages</span><span>${a.useAi ? `${a.waMsgDay.toLocaleString()}/day · ${a.waMsgHour.toFixed(0)}/h peak` : '—'}</span></div>
              <div class="flex justify-between"><span>wa-ai processes</span><span>${a.waAiProcs ? `${a.waAiProcs}${LAYOUTS[a.layout].waAi > 1 ? ` (${a.waAi} × ${LAYOUTS[a.layout].waAi})` : ''}` : '—'}</span></div>
              <div class="flex justify-between"><span>PHP processes</span><span>${a.phpProcs}</span></div>
              <div class="flex justify-between"><span>PostgreSQL connections</span><span>${a.dbConn}${pooled() ? ' (pool)' : ''}</span></div>
            </div>

            <p class="text-xs font-semibold mt-4 mb-2">Disk, and where it comes from</p>
            <div class="space-y-2 text-[11px]">
              <div>
                <div class="flex justify-between font-medium text-ink"><span>Code &amp; releases</span><span>${a.codeDisk} GB</span></div>
                <p class="text-faint leading-relaxed mt-0.5">
                  ${K.releaseMb} MB per release (app + <span class="font-mono">vendor/</span> + built assets)
                  × ${K.releasesKept} kept for rollback, plus ${K.logGb} GB of logs.
                </p>
              </div>
              <div>
                <div class="flex justify-between font-medium text-ink"><span>File storage</span><span>${a.fileDisk} GB</span></div>
                <p class="text-faint leading-relaxed mt-0.5">${a.users} users × ${K.diskUser} GB quota each. This is the quota sold, not measured usage.</p>
              </div>
              <div>
                <div class="flex justify-between font-medium text-ink"><span>Database size</span><span>${a.dbDisk} GB</span></div>
                <p class="text-faint leading-relaxed mt-0.5">
                  ${a.userRowsDay.toLocaleString()} rows/day from users
                  (${a.users} × ${K.rowsPerUserDay[a.intensity]} for ${INTENSITY[a.intensity].label.toLowerCase()} use)${
                    a.waRowsDay ? ` + ${a.waRowsDay.toLocaleString()} from the AI assistant (${a.waMsgDay.toLocaleString()} msg/day × ${K.waRowsPerMsg} rows)` : ''}
                  = ${a.rowsDay.toLocaleString()}/day.<br>
                  × ${K.retentionDays} days × ${K.rowKb} KB per row incl. indexes, plus ${K.dbSeedGb} GB of schema and master data.
                </p>
              </div>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
}).join('');
}

function renderThroughput(snap) {
const t = throughput(snap);
const q = pct(t.demand, t.ceiling);
const fmt = n => Number.isFinite(n) ? n.toFixed(1) : '—';

$('throughput').innerHTML = `
  <section class="bg-white rounded-xl border border-line shadow-card overflow-hidden">
    <div class="p-5">
      <div class="mb-4">
        <h3 class="text-sm font-semibold">Can the website keep up?</h3>
        <p class="text-xs text-muted mt-0.5">Separate from memory — this is about pages loading quickly when everyone is working at once.</p>
      </div>

      <div class="flex flex-wrap items-end gap-x-10 gap-y-4 mb-4">
        <div>
          <p class="text-xs text-muted mb-1">Busiest hour today</p>
          <p class="text-2xl font-bold tabular-nums leading-none">${t.demandMin.toFixed(0)}
            <span class="text-sm font-normal text-faint">requests / min</span></p>
          <p class="text-[11px] text-faint mt-1">${t.webMin.toFixed(0)} page loads
            ${t.mobMin > 0 ? `· ${t.mobMin.toFixed(0)} mobile API calls` : ''}</p>
        </div>
        <div>
          <p class="text-xs text-muted mb-1">This server can handle</p>
          <p class="text-2xl font-semibold tabular-nums text-primary leading-none">${Number.isFinite(t.ceilingMin) ? t.ceilingMin.toFixed(0) : '—'}
            <span class="text-sm font-normal text-faint">requests / min</span></p>
          ${t.mobMin > 0 ? `<p class="text-[11px] text-faint mt-1">at the current mix — API calls are cheaper than pages</p>` : ''}
        </div>
        ${t.ratio !== null ? `
        <div class="ml-auto text-right">
          <p class="text-xs text-muted mb-1">Spare</p>
          <p class="text-2xl font-semibold tabular-nums leading-none ${
            t.ratio < 1 ? 'text-danger' : t.ratio < 2 ? 'text-warn' : 'text-ok'}">${t.ratio.toFixed(0)}×</p>
        </div>` : ''}
      </div>

      <div class="h-2 rounded-full track overflow-hidden">
        <div class="h-full ${tone(q)} rounded-full transition-all" style="width:${q}%"></div>
      </div>

      <div class="mt-3 text-xs leading-relaxed space-y-1.5">
        ${t.ratio === null ? `
          <p class="text-muted">No apps registered yet, so this is just the bare ceiling of the hardware.</p>`
        : t.ratio < 1 ? `
          <p class="text-danger font-medium">Too slow. The apps ask for more than this server can deliver.</p>
          <p class="text-muted">At the busiest hour, pages will queue up and eventually time out. Add cores, or move an app elsewhere.</p>`
        : t.ratio < 2 ? `
          <p class="text-warn font-medium">Tight. Only ${t.ratio.toFixed(1)}× more than the busiest hour needs.</p>
          <p class="text-muted">One heavy report or a sudden rush and users will notice pages hesitating.</p>`
        : `
          <p class="text-ok font-medium">Plenty of room. The website is nowhere near its limit.</p>
          <p class="text-muted">
            ${t.spareUsers > 0
              ? `Roughly <span class="font-semibold text-ink">${t.spareUsers.toLocaleString()} more people</span> could work at the same
                 intensity as the ${t.totalUsers} already registered, before pages start slowing down.`
              : 'Traffic is far below what this hardware can serve.'}
          </p>`}
        <p class="text-faint">
          The cap comes from ${t.limiter === 'CPU'
            ? 'processor power — there are not enough cores to finish requests any faster'
            : `how many requests can be worked on at once (${t.slots} php-fpm slots), not from processor power`}.
        </p>
      </div>
    </div>

    <button data-open="thr" class="w-full px-5 py-3 border-t border-line bg-shell/50 hover:bg-shell text-left transition flex items-center justify-between">
      <span class="text-xs font-medium text-muted">How this number is reached</span>${chev('thr')}
    </button>
    <div id="p-thr" class="${open.has('thr') ? '' : 'hidden'} px-5 py-4 bg-shell/50 border-t border-line">
      <div class="grid gap-5 sm:grid-cols-2">
        <div class="space-y-1.5 text-[11px]">
          <p class="text-xs font-semibold mb-2">Two independent ceilings</p>
          <div class="flex justify-between ${t.byCpu <= t.bySlots ? 'font-semibold text-ink' : 'text-muted'}">
            <span>CPU allows</span><span class="tabular-nums">${fmt(t.byCpu)} req/s</span></div>
          <div class="flex justify-between ${t.bySlots < t.byCpu ? 'font-semibold text-ink' : 'text-muted'}">
            <span>PHP-FPM slots allow</span><span class="tabular-nums">${fmt(t.bySlots)} req/s</span></div>
          <div class="flex justify-between pt-1.5 mt-1.5 border-t border-line font-semibold text-primary">
            <span>Whichever is lower</span><span class="tabular-nums">${fmt(t.ceiling)} req/s</span></div>
        </div>
        <div class="space-y-1.5 text-[11px] text-muted">
          <p class="text-xs font-semibold text-ink mb-2">Working</p>
          <div class="flex justify-between"><span>Cores usable for apps</span><span class="tabular-nums">${t.cpuNet.toFixed(2)}</span></div>
          <div class="flex justify-between"><span>− burnt by queue workers</span><span class="tabular-nums">${t.queueCpu.toFixed(2)}</span></div>
          <div class="flex justify-between"><span>left for web requests</span><span class="tabular-nums">${t.webCpu.toFixed(2)} cores</span></div>
          <div class="flex justify-between pt-1.5 mt-1.5 border-t border-line"><span>÷ ${K.cpuReq} core-s per request</span><span class="tabular-nums">${fmt(t.byCpu)} req/s</span></div>
          <div class="flex justify-between pt-2"><span>php-fpm children total</span><span class="tabular-nums">${t.slots}</span></div>
          <div class="flex justify-between"><span>÷ ${K.respTime} s per request</span><span class="tabular-nums">${fmt(t.bySlots)} req/s</span></div>
        </div>
      </div>
      <p class="text-[11px] text-faint mt-4 leading-relaxed">
        Both figures rest on assumptions — 0.30 s average response and 0.10 core-seconds of CPU per request.
        To replace them with measured values, switch on the PHP-FPM access log with
        <span class="font-mono">%{mili}d</span> and read the real percentiles after a day of traffic.
      </p>
    </div>
  </section>`;
}

function renderLimits(snap) {
const conn = snap.computed.reduce((s, a) => s + a.dbConn, 0);
const redisUsed = apps.length + K.redisRsv;

const card = (title, used, max, hint) => {
  const q = pct(used, max);
  return `<div class="bg-white rounded-xl border border-line shadow-card p-5">
    <div class="flex items-baseline justify-between mb-2">
      <span class="text-[13px] font-medium">${title}</span>
      <span class="text-[13px] tabular-nums ${q >= 90 ? 'text-danger font-semibold' : q >= 70 ? 'text-warn' : 'text-muted'}">${used} / ${max}</span>
    </div>
    <div class="h-1.5 rounded-full track overflow-hidden"><div class="h-full ${tone(q)} rounded-full transition-all" style="width:${q}%"></div></div>
    <p class="text-xs text-muted mt-2.5 leading-relaxed">${hint}</p>
  </div>`;
};

$('hardLimits').innerHTML =
  card('PostgreSQL connections', conn, usableConn(), pooled()
    ? `PgBouncer gives each app database a fixed pool of ${K.poolSize} real connections, however many PHP processes sit in front of it. Against PostgreSQL's shipped limit of ${maxConn()}, minus ${K.connReserved} held for superusers.`
    : `Every PHP process holds its own connection. PostgreSQL ships with ${maxConn()}, minus ${K.connReserved} for superusers. Cross this line and apps fail to connect outright — not just slow down.`) +
  card('Redis databases', redisUsed, S.redisDb,
    `One per app, holding both queues and cache. ${K.redisRsv} are reserved for Bouncer and WhatsApp Service.`);
}

/* ═══════════════════════════════════════════════════════════
 MODAL
 ═══════════════════════════════════════════════════════════ */
function renderModal() {
const v = VARIANTS[form.variant];
const caps = roles().map(capacity);
const a = compute(form);
const p = pointsOf(a, caps);
const T = TIER[a.tier];
const others = apps.filter(x => x.id !== editingId).map(compute).reduce((s, x) => s + pointsOf(x, caps).points, 0);
const after = others + p.points;

const customRows = (form.custom || []).map((c, i) => `
  <div class="grid grid-cols-[1fr_70px_110px_32px] gap-2 items-end">
    <div><input data-c="${i}:name" value="${esc(c.name)}" placeholder="queue name" class="field"></div>
    <div><input data-c="${i}:procs" type="text" inputmode="numeric" autocomplete="off" value="${esc(String(c.procs))}" placeholder="1" class="field"></div>
    <div><select data-c="${i}:weight" class="field">${opts(WEIGHT, c.weight, x => x.label)}</select></div>
    <button data-cdel="${i}" class="icon-btn danger mb-0.5">${ICON_TRASH}</button>
  </div>`).join('');

$('modalTitle').textContent = editingId ? 'Edit SunnyApp' : 'Add SunnyApp';
$('btnSave').textContent = editingId ? 'Save changes' : 'Add to server';

$('modalBody').innerHTML = `
  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <label class="lbl">App name</label>
      <input data-f="name" value="${esc(form.name)}" placeholder="Sunny-Client" class="field">
    </div>
    <div>
      <label class="lbl">Package variant</label>
      <select data-f="variant" class="field">${opts(VARIANTS, form.variant, x => x.label)}</select>
    </div>
    <div>
      <label class="lbl">Number of users</label>
      <!-- text, not number: keeps the field genuinely empty while editing and lets the caret be restored -->
      <input data-f="users" type="text" inputmode="numeric" autocomplete="off"
             value="${esc(String(form.users))}" placeholder="15" class="field">
      <p class="text-xs text-faint mt-1.5">Minimum subscription is 5 users. Each user includes 1 GB of file storage.</p>
    </div>
    <div>
      <label class="lbl">Of those, how many get the mobile app</label>
      <input data-f="mobileUsers" type="text" inputmode="numeric" autocomplete="off"
             value="${esc(String(form.mobileUsers))}" placeholder="0" class="field">
      <p class="text-xs text-faint mt-1.5 leading-relaxed">
        Mobile access is granted per person, not to everyone. The app is a REST client against this
        same Laravel, so it shares the web server pool.
        ${a.mobileUsers > 0
          ? `<span class="text-ink">${a.mobileUsers} phone${a.mobileUsers === 1 ? '' : 's'}
             add about ${(a.mobileRps * 60).toFixed(0)} API calls a minute at peak.</span>`
          : ''}
      </p>
    </div>
    <div>
      <label class="lbl">How heavily they use it</label>
      <select data-f="intensity" class="field">${opts(INTENSITY, form.intensity, x => x.label)}</select>
      <p class="text-xs text-faint mt-1.5">${INTENSITY[form.intensity].note}</p>
    </div>
  </div>

  <div class="rounded-xl border border-line overflow-hidden">
    <div class="flex items-center justify-between gap-4 px-4 py-3 ${form.useAi ? 'bg-primary-50' : 'bg-shell/50'}">
      <div>
        <p class="text-[13px] font-medium">WhatsApp AI Assistant</p>
        <p class="text-xs text-muted mt-0.5">Staff look things up and file records by messaging Solaris on WhatsApp.</p>
      </div>
      <button data-toggle-ai role="switch" aria-checked="${form.useAi}"
        class="relative w-11 h-6 rounded-full transition shrink-0 ${form.useAi ? 'bg-primary' : 'bg-line'}">
        <span class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${form.useAi ? 'left-[22px]' : 'left-0.5'}"></span>
      </button>
    </div>
    ${form.useAi ? `
    <div class="px-4 py-3 border-t border-line">
      <label class="lbl">How Bouncer delivers incoming events</label>
      <select data-f="waTransport" class="field">${opts(WA_TRANSPORT, form.waTransport, x => x.label)}</select>
      <p class="text-xs text-faint mt-1.5 leading-relaxed">
        ${WA_TRANSPORT[form.waTransport].note}
        Costs ${form.waTransport === 'url'
          ? `a <span class="font-mono">wa-webhook</span> queue worker`
          : `${VARIANTS[form.variant].bridges} resident <span class="font-mono">redis-subscribe</span> process${VARIANTS[form.variant].bridges > 1 ? 'es' : ''}`}.
      </p>
    </div>
    <div class="px-4 py-3 border-t border-line">
      <label class="lbl">How much the team uses it</label>
      <select data-f="aiUse" class="field">${opts(AI_USE, form.aiUse, x => x.label)}</select>
      <div class="text-xs text-faint mt-2 leading-relaxed space-y-1">
        <p>${AI_USE[form.aiUse].note}</p>
        <div class="font-mono text-[11px] bg-shell/70 rounded-lg border border-line p-2.5 space-y-0.5">
          <div>${a.aiUsers} of ${a.users} people use it (${(AI_USE[form.aiUse].share * 100).toFixed(0)}%)</div>
          <div>× ${AI_USE[form.aiUse].sessions} conversations a day × ${K.aiTurns} questions each
            = <span class="text-ink font-semibold">${a.waMsgDay.toLocaleString()} messages/day</span></div>
          <div>÷ ${K.waActiveHours} working hours × ${K.aiPeakFactor} for the busy hour
            = <span class="text-ink font-semibold">${a.waMsgHour.toFixed(0)} messages/hour</span></div>
          <div>× ${K.waAiSec} s per reply ÷ ${K.waAiUtil * 100}% target load
            = <span class="text-ink font-semibold">${a.waAi} process${a.waAi === 1 ? '' : 'es'}</span>
            ${LAYOUTS[form.layout].waAi > 1
              ? `× ${LAYOUTS[form.layout].waAi} for ${LAYOUTS[form.layout].label} workers
                 = <span class="text-ink font-semibold">${a.waAiProcs}</span>` : ''}</div>
        </div>
      </div>
    </div>` : ''}
  </div>

  ${v.blast ? `
  <div class="rounded-xl border border-line p-4 space-y-4">
    <div>
      <p class="text-[13px] font-medium">Campaign volume</p>
      <p class="text-xs text-muted mt-0.5">The ${v.label} package can send blasts. Heavier use needs more sending processes.</p>
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <div>
        <label class="lbl">WhatsApp blast</label>
        <select data-f="waBlast" class="field">${opts(BLAST, form.waBlast, x => x.label)}</select>
        <p class="text-xs text-faint mt-1.5">${BLAST[form.waBlast].note}</p>
      </div>
      <div>
        <label class="lbl">Email blast</label>
        <select data-f="emailBlast" class="field">${opts(BLAST, form.emailBlast, x => x.label)}</select>
        <p class="text-xs text-faint mt-1.5">${BLAST[form.emailBlast].note}</p>
      </div>
    </div>
  </div>` : ''}

  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <label class="lbl">Worker processes</label>
      <select data-f="layout" class="field">${opts(LAYOUTS, form.layout, x => x.label)}</select>
      <p class="text-xs text-faint mt-1.5 leading-relaxed">${LAYOUTS[form.layout].note}</p>
    </div>
    <div>
      <label class="lbl">Web server pool</label>
      <select data-f="fpmMode" class="field">${opts(FPM_MODE, form.fpmMode, x => x.label)}</select>
      <p class="text-xs text-faint mt-1.5 leading-relaxed">
        ${FPM_MODE[form.fpmMode].note}
        ${a.shared
          ? `Needs ${a.fpm} children at peak, charged ${a.fpmCharged} because the pool is shared.`
          : `Reserves all ${a.fpm} children for itself.`}
      </p>
    </div>
  </div>

  <div class="rounded-xl border border-line p-4 space-y-3">
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="text-[13px] font-medium">Custom queues</p>
        <p class="text-xs text-muted mt-0.5">Extra worker processes this client's custom build needs.</p>
      </div>
      <button data-cadd class="text-xs font-medium text-primary hover:underline shrink-0 mt-0.5">+ Add queue</button>
    </div>
    ${form.custom.length ? `
      <div class="grid grid-cols-[1fr_70px_110px_32px] gap-2 text-[10px] uppercase tracking-wide text-faint">
        <span>Name</span><span>Procs</span><span>Weight</span><span></span>
      </div>
      <div class="space-y-2">${customRows}</div>
      <p class="text-xs text-faint leading-relaxed">${WEIGHT[form.custom[form.custom.length - 1].weight].note} —
        light ${K.proc.light} MB, medium ${K.proc.medium} MB, heavy ${K.proc.heavy} MB per process.</p>
    ` : `<p class="text-xs text-faint">None. Standard Solaris queues only.</p>`}
  </div>

  <div class="rounded-xl border border-line bg-shell/60 p-4 flex items-center justify-between gap-4">
    <div>
      <p class="text-xs text-muted mb-1">This app will cost</p>
      <div class="flex items-baseline gap-1.5">
        <span class="text-2xl font-bold tabular-nums text-primary leading-none">${p.points.toFixed(1)}</span>
        <span class="text-xs text-faint">points · ${p.driver ? p.driver.dim + ' bound' : ''}</span>
      </div>
    </div>
    <div class="text-right text-xs space-y-1">
      <div><span class="text-muted">Tier</span> <span class="font-medium px-1.5 py-0.5 rounded ${T.cls}">${T.label}</span></div>
      <div class="text-muted">${a.workerCount} workers · ${a.fpmCharged} web · ${gb(a.ramEff)}</div>
      <div class="${after > 100 ? 'text-danger font-medium' : 'text-muted'}">Server would sit at ${after.toFixed(1)} / 100</div>
    </div>
  </div>`;
}

function openModal(id = null) {
editingId = id;
form = id ? JSON.parse(JSON.stringify(apps.find(a => a.id === id))) : blankForm();
$('modal').classList.remove('hidden');
renderModal();
}
const closeModal = () => { $('modal').classList.add('hidden'); editingId = null; };

/* ═══════════════════════════════════════════════════════════
 ORCHESTRATION
 ═══════════════════════════════════════════════════════════ */
function renderOutputs() {
const snap = snapshot();
renderScore(snap);
renderTable(snap);
renderThroughput(snap);
renderLimits(snap);
}

function renderAll() {
renderStepper();
if (S.stage === 1) renderStage1();
if (S.stage === 2) renderStage2();
if (S.stage === 3) renderOutputs();
if (!$('modal').classList.contains('hidden')) renderModal();
}

/* ═══════════════════════════════════════════════════════════
 EVENTS — delegated, so re-renders never orphan a handler
 ═══════════════════════════════════════════════════════════ */
document.addEventListener('click', e => {
const set = e.target.closest('[data-set]');
if (set) { const [k, val] = set.dataset.set.split(':'); S[k] = val; return renderAll(); }

const nav = e.target.closest('[data-goto]');
if (nav && !nav.disabled) return goto(+nav.dataset.goto);

if (e.target.closest('[data-toggle-ai]')) { form.useAi = !form.useAi; return renderModal(); }
if (e.target.closest('[data-cadd]')) { form.custom.push({ name: '', procs: 1, weight: 'light' }); return renderModal(); }

const cdel = e.target.closest('[data-cdel]');
if (cdel) { form.custom.splice(+cdel.dataset.cdel, 1); return renderModal(); }

const ed = e.target.closest('[data-edit]');
if (ed) { e.stopPropagation(); return openModal(+ed.dataset.edit); }

const del = e.target.closest('[data-del]');
if (del) { e.stopPropagation(); apps = apps.filter(x => x.id !== +del.dataset.del); return renderOutputs(); }

const tog = e.target.closest('[data-open]');
if (tog) {
  const k = tog.dataset.open;
  open.has(k) ? open.delete(k) : open.add(k);
  const panel = $('p-' + k);
  if (panel) panel.classList.toggle('hidden', !open.has(k));
  const c = tog.querySelector('.js-chev');
  if (c) c.style.transform = open.has(k) ? 'rotate(180deg)' : '';
}
});

/* keeps the caret where it was when a keystroke forces a redraw */
function redrawKeepingFocus(selector) {
const active = document.activeElement;
const pos = active && active.selectionStart;
const scroll = $('modalBody').scrollTop;
renderModal();
$('modalBody').scrollTop = scroll;
const again = document.querySelector(selector);
if (!again) return;
again.focus();
if (pos != null && again.setSelectionRange && again.type !== 'number') {
  try { again.setSelectionRange(pos, pos); } catch (_) {}
}
}

document.addEventListener('input', e => {
const t = e.target;

if (t.dataset.srv) {
  servers[t.dataset.srv][t.dataset.key] = +t.value || null;
  $('next2').disabled = !specsFilled();
  renderReserve();          // reserve is a share of the spec, so it moves with it
  renderDefaults();         // the safe upper bound advice depends on database RAM
  return renderStepper();
}
if (t.id === 'maxConn') { S.maxConn = +t.value || null; return renderLimitsPanel(); }
if (t.id === 'redisDb') { S.redisDb = +t.value || 1; S.touched.redisDb = true; return renderLimitsPanel(); }

/* digits are kept as the raw string the user typed — coercing here would turn an
   empty field back into "0" mid-backspace. compute() does the conversion instead. */
const digits = v => v.replace(/[^0-9]/g, '');

if (t.dataset.c) {
  const [i, key] = t.dataset.c.split(':');
  if (key === 'procs') t.value = digits(t.value);
  form.custom[+i][key] = t.value;
  return redrawKeepingFocus(`[data-c="${i}:${key}"]`);
}

if (t.dataset.f) {
  const k = t.dataset.f;
  if (k === 'users' || k === 'mobileUsers') t.value = digits(t.value);
  form[k] = t.value;
  if (k === 'variant') return renderModal();
  return redrawKeepingFocus(`[data-f="${k}"]`);
}
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

$('next1').addEventListener('click', () => goto(2));
$('next2').addEventListener('click', () => goto(3));
$('btnOpen').addEventListener('click', () => openModal());
$('btnOpen2').addEventListener('click', () => openModal());
$('btnClear').addEventListener('click', () => { apps = []; open.clear(); renderOutputs(); });

$('btnSave').addEventListener('click', () => {
if (!form.users || form.users < 1) return;
const payload = { ...form, name: form.name.trim() || 'Untitled App' };
if (editingId) {
  const i = apps.findIndex(a => a.id === editingId);
  if (i > -1) apps[i] = { ...payload, id: editingId };
} else {
  apps.push({ ...payload, id: seq++ });
}
closeModal();
renderOutputs();
});

$('btnReset').addEventListener('click', () => {
apps = []; open.clear(); seq = 1; editingId = null;
S.deploy = null; S.storage = 'minio'; S.pooling = 'pgbouncer'; S.reserve = 'standard';
S.redisDb = K.redisDbs; S.maxConn = null; S.touched = {};
Object.keys(servers).forEach(r => { servers[r] = { cores: null, ram: null, disk: null }; });
goto(1);
});

renderAll();
