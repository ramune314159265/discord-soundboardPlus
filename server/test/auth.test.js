import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guildIconUrl } from '../src/auth.js'

test('guildIconUrl: static, animated, and missing icons', () => {
  assert.equal(guildIconUrl('1', 'abc123'), 'https://cdn.discordapp.com/icons/1/abc123.png?size=64')
  assert.equal(guildIconUrl('1', 'a_abc123'), 'https://cdn.discordapp.com/icons/1/a_abc123.gif?size=64')
  assert.equal(guildIconUrl('1', null), null)
  assert.equal(guildIconUrl('1', undefined), null)
})

test('guildIconUrl: unexpected hashes never produce a URL (no injection into the CDN path)', () => {
  assert.equal(guildIconUrl('1', '../../evil'), null)
  assert.equal(guildIconUrl('1', 'abc?x=1'), null)
  assert.equal(guildIconUrl('1', ''), null)
})
