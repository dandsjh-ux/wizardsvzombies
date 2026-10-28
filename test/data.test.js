import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSES, CLASS_SPELLS, CLASS_CONSTRUCTS, SPELLS, waveSpec, BOSS_BY_WAVE, TOTAL_WAVES, xpToNext, quizStreakMult } from '../shared/data.js';
import { QUIZ_BANK } from '../server/quiz-bank.js';
import { buildFenceSegments, buildLayout, buildObstacles } from '../shared/layout.js';

test('every class has 8 spells, 3 constructs and owns its starting spells', () => {
  for (const cls of Object.keys(CLASSES)) {
    assert.equal(CLASS_SPELLS[cls].length, 8, cls);
    assert.equal(CLASS_CONSTRUCTS[cls].length, 3, cls);
    for (const s of CLASSES[cls].start) assert.equal(SPELLS[s].cls, cls);
  }
});

test('waves: 30 waves, bosses every 10th, counts grow with wave and party size', () => {
  assert.equal(TOTAL_WAVES, 30);
  assert.deepEqual(Object.keys(BOSS_BY_WAVE).map(Number), [10, 20, 30]);
  for (let w = 1; w <= TOTAL_WAVES; w++) {
    const s1 = waveSpec(w, 1), s3 = waveSpec(w, 3);
    assert.ok(s1.count > 0 && s3.count > s1.count, `wave ${w}`);
    const mixTotal = Object.values(s1.mix).reduce((a, b) => a + b, 0);
    assert.equal(mixTotal, s1.count, `wave ${w} mix adds up`);
    if (w > 1) assert.ok(waveSpec(w, 2).count >= waveSpec(w - 1, 2).count);
  }
});

test('quiz bank: 50 well-formed noun/adjective/verb questions', () => {
  assert.equal(QUIZ_BANK.length, 50);
  for (const q of QUIZ_BANK) {
    assert.ok(['noun', 'adjective', 'verb'].includes(q.type), q.q);
    assert.equal(q.choices.length, 4, q.q);
    assert.equal(new Set(q.choices).size, 4, q.q);
    assert.ok(q.a >= 0 && q.a < 4, q.q);
    assert.ok(q.explain.length > 10, q.q);
  }
  const types = new Set(QUIZ_BANK.map((q) => q.type));
  assert.equal(types.size, 3);
});

test('xp curve and quiz streaks increase', () => {
  for (let l = 1; l < 30; l++) assert.ok(xpToNext(l + 1) > xpToNext(l));
  assert.equal(quizStreakMult(1), 1);
  assert.ok(quizStreakMult(5) > quizStreakMult(2));
  assert.equal(quizStreakMult(50), 5);
});

test('palisade is a closed ring with a gate on each side', () => {
  const segs = buildFenceSegments();
  assert.equal(segs.filter((s) => s.gate).length, 4);
  assert.equal(segs.length, 124);
  const obs = buildObstacles(buildLayout());
  assert.ok(obs.length > 50);
});
