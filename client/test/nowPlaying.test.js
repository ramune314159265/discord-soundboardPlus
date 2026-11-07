import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRemaining, mergeNowPlaying, progressOf, sortByEndLatestFirst } from '../src/nowPlaying.js'

const voice = (id, soundId, positionMs, durationMs) => ({ id, soundId, userId: 'u', positionMs, durationMs })

test('mergeNowPlaying: start and end are fixed from the position when the sound is first seen', () => {
  const [item] = mergeNowPlaying([], [voice('1', 'a', 300, 1000)], 10_000)
  assert.equal(item.startedAt, 9_700)
  assert.equal(item.endsAt, 10_700)
  assert.equal(item.durationMs, 1000)
})

test('mergeNowPlaying: later updates do not move a known sound (no jitter), and finished ones disappear', () => {
  const first = mergeNowPlaying([], [voice('1', 'a', 0, 1000), voice('2', 'b', 0, 500)], 1_000)
  const next = mergeNowPlaying(first, [voice('1', 'a', 240, 1000), voice('3', 'c', 0, 700)], 1_260)
  assert.deepEqual(next.map((p) => p.id), ['1', '3'])
  assert.equal(next[0].endsAt, first[0].endsAt, 'unchanged although the position says 240ms at 260ms')
  assert.equal(next[1].startedAt, 1_260)
})

test('mergeNowPlaying: a reused id with a different sound is treated as a new sound (bot re-joined)', () => {
  const first = mergeNowPlaying([], [voice('1', 'a', 0, 1000)], 1_000)
  const [again] = mergeNowPlaying(first, [voice('1', 'b', 0, 300)], 90_000)
  assert.equal(again.soundId, 'b')
  assert.equal(again.endsAt, 90_300)
})

test('mergeNowPlaying: missing length/position are tolerated', () => {
  const [item] = mergeNowPlaying([], [{ id: '1', soundId: 'a', userId: 'u' }], 5_000)
  assert.equal(item.durationMs, null)
  assert.equal(item.endsAt, null)
  assert.deepEqual(progressOf(item, 6_000), { ratio: null, remainingMs: null })
  assert.deepEqual(mergeNowPlaying([], undefined, 1), [])
})

test('sortByEndLatestFirst: the one that finishes last is on top; ties go to the newer sound; unknown length first', () => {
  const items = mergeNowPlaying(
    [],
    [voice('1', 'a', 0, 1000), voice('2', 'b', 0, 5000), voice('3', 'c', 0, 3000), voice('4', 'd', 0, 3000), { id: '5', soundId: 'e', userId: 'u' }],
    0,
  )
  assert.deepEqual(sortByEndLatestFirst(items).map((p) => p.id), ['5', '2', '4', '3', '1'])
  assert.deepEqual(items.map((p) => p.id), ['1', '2', '3', '4', '5'], 'the input is not modified')
})

test('sort: the order is stable over time (a longer sound that started earlier can still finish last)', () => {
  // 10秒の音が 8 秒目に鳴り始めた (終わりは 18 秒) 一方、5秒の音が 0 秒目から (終わりは 5 秒)。
  const items = [...mergeNowPlaying([], [voice('1', 'a', 0, 5000)], 0), ...mergeNowPlaying([], [voice('2', 'b', 0, 10_000)], 8_000)]
  assert.deepEqual(sortByEndLatestFirst(items).map((p) => p.id), ['2', '1'])
})

test('progressOf: ratio and remaining time follow the clock, and clamp at both ends', () => {
  const [item] = mergeNowPlaying([], [voice('1', 'a', 0, 2000)], 1_000)
  assert.deepEqual(progressOf(item, 500), { ratio: 0, remainingMs: 2000 }, 'before the start')
  assert.deepEqual(progressOf(item, 1_500), { ratio: 0.25, remainingMs: 1500 })
  assert.deepEqual(progressOf(item, 3_000), { ratio: 1, remainingMs: 0 })
  assert.deepEqual(progressOf(item, 99_000), { ratio: 1, remainingMs: 0 })
})

test('formatRemaining', () => {
  assert.equal(formatRemaining(0), '0.0秒')
  assert.equal(formatRemaining(1), '0.1秒')
  assert.equal(formatRemaining(1_234), '1.3秒')
  assert.equal(formatRemaining(59_000), '59.0秒')
  assert.equal(formatRemaining(65_000), '1:05')
  assert.equal(formatRemaining(null), '')
})
