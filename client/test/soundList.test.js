import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TAGS, MAX_TAG_LENGTH, addTag, collectTags, filterByTags, normalizeTag, removeTag, splitTagInput } from '../src/soundList.js'

test('normalizeTag trims, collapses spaces and limits the length', () => {
  assert.equal(normalizeTag('  ネタ   音 '), 'ネタ 音')
  assert.equal(normalizeTag('a\u0000b'), 'ab')
  assert.equal([...normalizeTag('あ'.repeat(50))].length, MAX_TAG_LENGTH)
  assert.equal(normalizeTag(undefined), '')
})

test('addTag ignores empty, duplicates (case-insensitive) and anything past the limit', () => {
  const base = ['BGM']
  assert.equal(addTag(base, '  '), base)
  assert.equal(addTag(base, 'bgm'), base)
  assert.deepEqual(addTag(base, ' ネタ '), ['BGM', 'ネタ'])
  const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`)
  assert.equal(addTag(full, 'more'), full)
  assert.deepEqual(removeTag(['a', 'b'], 'a'), ['b'])
})

test('splitTagInput commits everything before the last separator', () => {
  assert.deepEqual(splitTagInput('abc'), { done: [], rest: 'abc' })
  assert.deepEqual(splitTagInput('a,b、c'), { done: ['a', 'b'], rest: 'c' })
  assert.deepEqual(splitTagInput('a,'), { done: ['a'], rest: '' })
})

test('collectTags counts usage, most used first', () => {
  const sounds = [{ tags: ['b', 'a'] }, { tags: ['a'] }, { tags: [] }, {}]
  assert.deepEqual(collectTags(sounds), [
    { tag: 'a', count: 2 },
    { tag: 'b', count: 1 },
  ])
})

test('filterByTags keeps sounds that have every selected tag (AND)', () => {
  const sounds = [
    { id: 1, tags: ['a', 'b'] },
    { id: 2, tags: ['a'] },
    { id: 3 },
  ]
  assert.equal(filterByTags(sounds, []), sounds)
  assert.deepEqual(filterByTags(sounds, ['a']).map((s) => s.id), [1, 2])
  assert.deepEqual(filterByTags(sounds, ['a', 'b']).map((s) => s.id), [1])
  assert.deepEqual(filterByTags(sounds, ['zzz']), [])
})
