const { test } = require('node:test');
const assert = require('node:assert');
const {
  appleToUnix,
  sumQty,
  digestForDate,
  readMaterialized,
  runOutcome,
} = require('../system/ingest/health-ingest.js');

test('appleToUnix converts apple epoch seconds to unix epoch (2026-07 range)', () => {
  const unixSec = appleToUnix(805003200);
  const d = new Date(unixSec * 1000);
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 6); // July (0-indexed)
});

test('sumQty sums the qty field across a metric JSON data array', () => {
  const metricJson = {
    date: 805003200,
    metric: 'Step Count',
    data: [
      { qty: 10, unit: 'count' },
      { qty: 20.4, unit: 'count' },
      { qty: 5.1, unit: 'count' },
    ],
  };
  assert.strictEqual(sumQty(metricJson), 35.5);
});

test('sumQty returns 0 for missing/empty data', () => {
  assert.strictEqual(sumQty({ data: [] }), 0);
  assert.strictEqual(sumQty({}), 0);
  assert.strictEqual(sumQty(null), 0);
});

test('digestForDate produces a body with steps and a workout line', () => {
  const inputs = {
    step_count: { data: [{ qty: 3000 }, { qty: 2327 }] },
    apple_exercise_time: { data: [{ qty: 15 }, { qty: 10 }] },
    sleep_analysis: null,
    heart_rate_variability: { data: [{ qty: 40 }, { qty: 50 }] },
    resting_heart_rate: { data: [{ qty: 60 }, { qty: 64 }] },
    mindful_minutes: { data: [{ qty: 19.48 }] },
  };
  const workouts = [
    { name: 'Cycling', duration: 948 },
  ];
  const body = digestForDate({ date: '2026-07-06', inputs, workouts });
  assert.match(body, /5,?327 steps|5327 steps/);
  assert.match(body, /Cycling \(16min\)/);
});

test('runOutcome: decode failures with no data = failure exit, genuine no-data = clean skip', () => {
  // Files existed but every decode failed — that's a broken run, not "no data".
  assert.deepStrictEqual(
    runOutcome({ anyMetric: false, decodeFailures: 6 }),
    { exitCode: 1, reason: 'decode-failures' }
  );
  // Nothing dropped for the date at all — clean skip.
  assert.deepStrictEqual(
    runOutcome({ anyMetric: false, decodeFailures: 0 }),
    { exitCode: 0, reason: 'no-data' }
  );
  // Data landed — write the digest (partial decode failures tolerated).
  assert.deepStrictEqual(
    runOutcome({ anyMetric: true, decodeFailures: 1 }),
    { exitCode: 0, reason: 'ok' }
  );
});

test('readMaterialized retries an EDEADLK (iCloud dataless) read after brctl download', () => {
  const buf = Buffer.from('bvx2-payload');
  let reads = 0;
  const downloads = [];
  const fakeFs = {
    readFileSync() {
      reads += 1;
      if (reads < 3) {
        const err = new Error('EDEADLK: resource deadlock avoided');
        err.code = 'EDEADLK';
        throw err;
      }
      return buf;
    },
  };
  const fakeExec = (cmd, args) => { downloads.push([cmd, ...args]); };
  const out = readMaterialized('/fake/file.hae', {
    fsMod: fakeFs, exec: fakeExec, sleep: () => {}, retries: 4,
  });
  assert.strictEqual(out, buf);
  assert.strictEqual(reads, 3);
  assert.strictEqual(downloads.length, 2);
  assert.deepStrictEqual(downloads[0], ['/usr/bin/brctl', 'download', '/fake/file.hae']);
});

test('readMaterialized retries the real macOS eviction error (errno -11, no EDEADLK mapping)', () => {
  // Node has no libuv mapping for errno 11 (EDEADLK) on macOS, so a real
  // evicted-file read throws code "Unknown system error -11" — NOT 'EDEADLK'.
  // This is exactly what the Jul 10-11 2026 health gap threw.
  const buf = Buffer.from('bvx2-payload');
  let reads = 0;
  const downloads = [];
  const fakeFs = {
    readFileSync() {
      reads += 1;
      if (reads < 2) {
        const err = new Error('Unknown system error -11: Unknown system error -11, read');
        err.code = 'Unknown system error -11';
        err.errno = -11;
        err.syscall = 'read';
        throw err;
      }
      return buf;
    },
  };
  const fakeExec = (cmd, args) => { downloads.push([cmd, ...args]); };
  const out = readMaterialized('/fake/file.hae', {
    fsMod: fakeFs, exec: fakeExec, sleep: () => {}, retries: 4,
  });
  assert.strictEqual(out, buf);
  assert.strictEqual(reads, 2);
  assert.strictEqual(downloads.length, 1);
});

test('readMaterialized gives up after retries and rethrows', () => {
  const fakeFs = {
    readFileSync() {
      const err = new Error('EDEADLK: resource deadlock avoided');
      err.code = 'EDEADLK';
      throw err;
    },
  };
  assert.throws(
    () => readMaterialized('/fake/file.hae', { fsMod: fakeFs, exec: () => {}, sleep: () => {}, retries: 2 }),
    /EDEADLK/
  );
});

test('readMaterialized does not retry non-dataless errors', () => {
  let reads = 0;
  const fakeFs = {
    readFileSync() {
      reads += 1;
      const err = new Error('ENOENT: no such file');
      err.code = 'ENOENT';
      throw err;
    },
  };
  assert.throws(
    () => readMaterialized('/fake/file.hae', { fsMod: fakeFs, exec: () => {}, sleep: () => {}, retries: 3 }),
    /ENOENT/
  );
  assert.strictEqual(reads, 1);
});

test('digestForDate omits sleep line when sleep data is absent/empty', () => {
  const inputs = {
    step_count: { data: [{ qty: 100 }] },
    apple_exercise_time: null,
    sleep_analysis: { data: [] },
    heart_rate_variability: null,
    resting_heart_rate: null,
    mindful_minutes: null,
  };
  const body = digestForDate({ date: '2026-07-06', inputs, workouts: [] });
  assert.doesNotMatch(body.toLowerCase(), /sleep/);
});
