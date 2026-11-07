import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { VoiceConnectionStatus } from '@discordjs/voice'
import { VoiceBot } from '../src/bot.js'
import { Mixer, OpusFrameEncoder } from '../src/mixer.js'
import { OpusCodec } from '../src/opusCodec.js'
import { BOT_ID, GUILD_ID, createFakeDiscord, sleep, waitFor } from './helpers/fakeDiscord.js'

const beepPath = fileURLToPath(new URL('./fixtures/beep.ogg', import.meta.url))
const T = { timeout: 4000 }

/**
 * 既定では各チャンネルに人間を1人ずつ入れておく (自動退出が結果に影響しないように)。
 * 自動退出のテストは humans: false で無人から始める。
 */
function setup(options = {}, botOptions = {}, { humans = true } = {}) {
  const fake = createFakeDiscord(options)
  // 出力は fake.lastPlayer().pull()/drain() で読んだ分だけ進める (実時間を待たない)
  const maxVoices = botOptions.maxVoices ?? 8
  const bot = new VoiceBot({
    client: fake.client,
    voice: fake.voice,
    autoLeaveDelayMs: 40,
    createMixer: () => new Mixer({ maxVoices, pacing: false, createEncoder: () => new OpusFrameEncoder() }),
    ...botOptions,
  })
  const states = []
  bot.on('state', (guildId) => states.push({ guildId, ...bot.getState(guildId) }))
  if (humans) {
    fake.setUser('human-c1', 'C1')
    fake.setUser('human-c2', 'C2')
  }
  return { fake, bot, states }
}

const setupAlone = (options, botOptions) => setup(options, botOptions, { humans: false })

// ---------------------------------------------------------------- 参加・移動

test('join: bot enters the channel and becomes ready', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
  assert.equal(fake.connection().state.status, VoiceConnectionStatus.Ready)
})

test('join: the bot is not speaker-muted (selfDeaf off)', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  assert.equal(fake.connection().joinConfig.selfDeaf, false)
  assert.equal(fake.connection().joinConfig.selfMute, false)
})

test('move: moving to another channel keeps the bot connected there (regression)', T, async () => {
  const { fake, bot, states } = setup()
  await bot.join(GUILD_ID, 'C1')
  const first = fake.connection()

  const started = Date.now()
  await bot.join(GUILD_ID, 'C2')
  assert.ok(Date.now() - started < 1500, 'join must not hang')
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C2')

  // 古い退出通知など、遅れて届くイベントが落ち着くまで待つ
  await sleep(120)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C2', 'bot must still be in the new channel')
  assert.equal(fake.connection(), first, 'the connection is reused, not recreated')
  assert.equal(first.destroyCount, 0)
  assert.equal(first.state.status, VoiceConnectionStatus.Ready)
  assert.ok(!states.some((s) => s.botChannelId === null), 'never reported as absent while moving')

  // 移動後もすぐ再生できる
  assert.equal(await bot.play(GUILD_ID, 'C2', { filePath: beepPath, soundId: 's', userId: 'u' }), 'ok')
})

test('move: a failed move leaves the existing connection alone', T, async () => {
  const { fake, bot } = setup({ channels: ['C1', 'C2'] }, {})
  await bot.join(GUILD_ID, 'C1')
  await assert.rejects(bot.join(GUILD_ID, 'nope'), { code: 'invalid_channel' })
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
  assert.equal(fake.connection().state.status, VoiceConnectionStatus.Ready)
})

test('join again to the same channel is a no-op', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  const connection = fake.connection()
  await bot.join(GUILD_ID, 'C1')
  assert.equal(fake.connection(), connection)
  assert.equal(connection.destroyCount, 0)
})

test('leave then re-join immediately: the stale leave notification is ignored (regression)', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  bot.leave(GUILD_ID)
  assert.equal(bot.getState(GUILD_ID).botChannelId, null)

  await bot.join(GUILD_ID, 'C1') // 退出通知(遅延)が届く前に再参加
  await sleep(120)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
  assert.equal(fake.connection().state.status, VoiceConnectionStatus.Ready)
})

test('leave: tears down, and the late leave notification does not break a later session', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  bot.leave(GUILD_ID)
  await sleep(60)
  assert.equal(bot.getState(GUILD_ID).botChannelId, null)
  await bot.join(GUILD_ID, 'C2')
  await sleep(60)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C2')
  assert.equal(fake.connection().state.status, VoiceConnectionStatus.Ready)
})

test('a pending join is aborted immediately when the session is torn down (no 20s hang)', T, async () => {
  const { bot } = setup({ neverReady: true })
  const pending = bot.join(GUILD_ID, 'C1')
  await sleep(30)
  const started = Date.now()
  bot.leave(GUILD_ID)
  await assert.rejects(pending, { code: 'disconnected' })
  assert.ok(Date.now() - started < 500)
})

// ---------------------------------------------------------------- 外部要因

test('kick: a genuine disconnect tears the session down', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  await sleep(30)
  fake.kickBot()
  assert.equal(bot.getState(GUILD_ID).botChannelId, null)
  assert.equal(fake.connection(), undefined)
  // もう一度参加できる
  await bot.join(GUILD_ID, 'C1')
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
})

test('moved by an admin: the state follows the new channel', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  await sleep(30)
  fake.moveBotByAdmin('C2')
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C2')
  assert.equal(fake.connection().destroyCount, 0)
})

// ---------------------------------------------------------------- 再生

const playOf = (bot, channel = 'C1') => (soundId, userId = 'u1', filePath = beepPath) =>
  bot.play(GUILD_ID, channel, { filePath, soundId, userId })
const nowPlayingIds = (bot) => bot.getState(GUILD_ID).nowPlaying.map((p) => p.soundId)

test('play: different sounds overlap and are all reported as playing', T, async () => {
  const { fake, bot, states } = setup()
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)

  assert.equal(await play('a', 'u1'), 'ok')
  assert.equal(await play('b', 'u2'), 'ok')
  assert.deepEqual(
    bot.getState(GUILD_ID).nowPlaying.map(({ soundId, userId }) => ({ soundId, userId })),
    [{ soundId: 'a', userId: 'u1' }, { soundId: 'b', userId: 'u2' }],
  )
  assert.deepEqual(nowPlayingIds({ getState: () => states.at(-1) }), ['a', 'b'], 'state event carries both')
  assert.equal(fake.lastPlayer().played.length, 1, 'both sounds share one output stream')
})

test('play: pressing the same sound again layers it on top (it is not ignored)', T, async () => {
  const { bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  assert.equal(await play('a'), 'ok')
  assert.equal(await play('a'), 'ok')
  assert.deepEqual(nowPlayingIds(bot), ['a', 'a'])
  const ids = bot.getState(GUILD_ID).nowPlaying.map((p) => p.id)
  assert.equal(new Set(ids).size, 2, 'each layer has its own id')
})

test('play: beyond the simultaneous limit it is rejected as busy and the existing sounds are untouched', T, async () => {
  const { bot } = setup({}, { maxVoices: 2 })
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  assert.equal(await play('a'), 'ok')
  assert.equal(await play('b'), 'ok')
  assert.equal(await play('c'), 'busy')
  assert.deepEqual(nowPlayingIds(bot), ['a', 'b'])
})

test('play: concurrent presses cannot exceed the limit', T, async () => {
  const { bot } = setup({}, { maxVoices: 3 })
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => play(`s${n}`)))
  assert.equal(results.filter((r) => r === 'ok').length, 3)
  assert.equal(results.filter((r) => r === 'busy').length, 2)
  assert.equal(bot.getState(GUILD_ID).nowPlaying.length, 3)
})

test('play: each playing sound reports its length and how far it has played (for the progress bar)', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  await playOf(bot)('a')
  const [first] = bot.getState(GUILD_ID).nowPlaying
  assert.ok(Math.abs(first.durationMs - 600) <= 40, `duration ${first.durationMs}`)
  assert.equal(first.positionMs, 0)

  fake.lastPlayer().pull(6)
  const [later] = bot.getState(GUILD_ID).nowPlaying
  assert.ok(later.positionMs >= 100 && later.positionMs <= 200, `position ${later.positionMs}`)
  assert.equal(later.positionMs % 20, 0)
  assert.equal(later.id, first.id)
})

test('play: sounds disappear from the state as they finish, then a new press starts a new output stream', T, async () => {
  const { fake, bot, states } = setup()
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  assert.equal(await play('a'), 'ok')

  fake.lastPlayer().drain() // 最後まで読み切る → 音が終わり、無音の猶予のあとストリームが閉じる
  await sleep(5)
  assert.deepEqual(bot.getState(GUILD_ID).nowPlaying, [])
  assert.deepEqual(states.at(-1).nowPlaying, [])
  assert.equal(fake.lastPlayer().state.status, 'idle')

  assert.equal(await play('b'), 'ok')
  assert.equal(fake.lastPlayer().played.length, 2, 'a fresh output stream is created')
  assert.deepEqual(nowPlayingIds(bot), ['b'])
})

test('play: a press right after the last sound ends joins the same stream without a gap', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  await play('a')
  // 'a' が終わって音が無くなったが、まだ無音の猶予中 (ストリームは閉じていない)
  const player = fake.lastPlayer()
  for (let i = 0; i < 40 && nowPlayingIds(bot).length > 0; i++) player.pull(1)
  assert.deepEqual(nowPlayingIds(bot), [])
  player.pull(2)

  assert.equal(await play('b'), 'ok')
  assert.equal(player.played.length, 1, 'no new stream, no restart')
  const decoder = new OpusCodec()
  const pcm = player.pull(3).map((packet) => decoder.decode(packet))
  decoder.delete()
  assert.ok(pcm.some((c) => c.some((byte) => byte !== 0)), 'the new sound is audible in the same stream')
})

test('play: the output is a stream of Opus packets (one per 20ms stereo frame) that decode to the sound', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  await playOf(bot)('a')
  const resource = fake.lastPlayer().played[0]
  assert.equal(resource.options.inputType, 'opus')
  const packets = fake.lastPlayer().pull(8)
  const decoder = new OpusCodec()
  const pcm = packets.map((packet) => decoder.decode(packet))
  decoder.delete()
  assert.ok(pcm.every((c) => c.length === 960 * 2 * 2), 'each packet is 20ms of stereo audio')
  assert.ok(pcm.some((c) => c.some((byte) => byte !== 0)), 'audible')
})

test('play: rejected from a channel the bot is not in', T, async () => {
  const { bot } = setup()
  assert.equal(await playOf(bot, 'C1')('a'), 'not_in_channel')
  await bot.join(GUILD_ID, 'C1')
  assert.equal(await playOf(bot, 'C2')('a'), 'not_in_channel')
})

test('play: a missing file and a broken file are reported without disturbing the sounds that are playing', T, async () => {
  const { bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  assert.equal(await play('a'), 'ok')
  assert.equal(await play('gone', 'u1', '/nonexistent/file.ogg'), 'unreadable')
  assert.equal(await play('junk', 'u1', fileURLToPath(import.meta.url)), 'invalid_sound')
  assert.deepEqual(nowPlayingIds(bot), ['a'])
})

test('play: leaving while the file is being read does not start a sound', T, async () => {
  const { bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  const pending = playOf(bot)('a')
  bot.leave(GUILD_ID)
  assert.equal(await pending, 'not_in_channel')
  assert.deepEqual(bot.getState(GUILD_ID).nowPlaying, [])
})

test('stop: stops only the chosen sound; the others keep playing', T, async () => {
  const { bot, states } = setup()
  await bot.join(GUILD_ID, 'C1')
  const play = playOf(bot)
  await play('a')
  await play('b')
  await play('a')
  const [first, second] = bot.getState(GUILD_ID).nowPlaying

  assert.equal(bot.stop(GUILD_ID, 'C1', second.id), 'ok')
  assert.deepEqual(bot.getState(GUILD_ID).nowPlaying.map((p) => p.soundId), ['a', 'a'])
  assert.ok(bot.getState(GUILD_ID).nowPlaying.every((p) => p.id !== second.id))
  assert.deepEqual(states.at(-1).nowPlaying.map((p) => p.id), bot.getState(GUILD_ID).nowPlaying.map((p) => p.id))
  assert.equal(bot.stop(GUILD_ID, 'C1', second.id), 'not_found', 'stopping twice is harmless')
  assert.ok(bot.getState(GUILD_ID).nowPlaying.some((p) => p.id === first.id))
})

test('stop: without an id it stops everything; wrong channel is rejected and changes nothing', T, async () => {
  const { bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  await playOf(bot)('a')
  await playOf(bot)('b')
  assert.equal(bot.stop(GUILD_ID, 'C2'), 'not_in_channel')
  assert.equal(bot.stop('999', 'C1'), 'not_in_channel')
  assert.equal(bot.getState(GUILD_ID).nowPlaying.length, 2)
  assert.equal(bot.stop(GUILD_ID, 'C1'), 'ok')
  assert.deepEqual(bot.getState(GUILD_ID).nowPlaying, [])
  // 止めたあとも鳴らせる
  assert.equal(await playOf(bot)('c'), 'ok')
})

test('leave: stops everything that is playing and closes the output stream', T, async () => {
  const { fake, bot } = setup()
  await bot.join(GUILD_ID, 'C1')
  await playOf(bot)('a')
  await playOf(bot)('b')
  const stream = fake.lastPlayer().played[0].stream
  bot.leave(GUILD_ID)
  assert.deepEqual(bot.getState(GUILD_ID).nowPlaying, [])
  assert.equal(stream.destroyed, true)
})

test('a player that stops by itself (error, external stop) clears the playing state', T, async () => {
  const { fake, bot, states } = setup()
  await bot.join(GUILD_ID, 'C1')
  await playOf(bot)('a')
  await playOf(bot)('b')
  fake.lastPlayer().finish()
  assert.deepEqual(bot.getState(GUILD_ID).nowPlaying, [])
  assert.deepEqual(states.at(-1).nowPlaying, [])
  // その後も鳴らせる
  assert.equal(await playOf(bot)('c'), 'ok')
  assert.deepEqual(nowPlayingIds(bot), ['c'])
})

// ---------------------------------------------------------------- 自動退出

test('auto-leave: leaves after the last human goes away', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  await bot.join(GUILD_ID, 'C1')
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')

  fake.setUser('u1', null)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1', 'waits for the grace period first')
  await waitFor(() => bot.getState(GUILD_ID).botChannelId === null)
  assert.equal(fake.connection(), undefined)
})

test('auto-leave: stays while at least one human remains', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  fake.setUser('u2', 'C1')
  await bot.join(GUILD_ID, 'C1')
  fake.setUser('u1', null)
  await sleep(120)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
})

test('auto-leave: coming back within the grace period cancels it', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  await bot.join(GUILD_ID, 'C1')
  fake.setUser('u1', null)
  await sleep(15)
  fake.setUser('u1', 'C1')
  await sleep(120)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
})

test('auto-leave: other bots do not count as company', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  fake.setUser('musicbot', 'C1', { bot: true })
  await bot.join(GUILD_ID, 'C1')
  fake.setUser('u1', null)
  await waitFor(() => bot.getState(GUILD_ID).botChannelId === null)
})

test('auto-leave: a member whose profile is not cached counts as a human (never leaves by mistake)', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('ghost', 'C1', { cached: false })
  await bot.join(GUILD_ID, 'C1')
  await sleep(120)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C1')
})

test('auto-leave: people in other channels are irrelevant', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  fake.setUser('u2', 'C2')
  await bot.join(GUILD_ID, 'C1')
  fake.setUser('u1', null)
  await waitFor(() => bot.getState(GUILD_ID).botChannelId === null)
})

test('auto-leave: follows the bot when it moves (the new channel decides)', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  fake.setUser('u2', 'C2')
  await bot.join(GUILD_ID, 'C1')
  await bot.join(GUILD_ID, 'C2')
  fake.setUser('u1', null) // 旧チャンネルの人が抜けても影響しない
  await sleep(120)
  assert.equal(bot.getState(GUILD_ID).botChannelId, 'C2')
  fake.setUser('u2', null)
  await waitFor(() => bot.getState(GUILD_ID).botChannelId === null)
})

test('auto-leave: with a zero delay it leaves immediately', T, async () => {
  const { fake, bot } = setupAlone({}, { autoLeaveDelayMs: 0 })
  fake.setUser('u1', 'C1')
  await bot.join(GUILD_ID, 'C1')
  fake.setUser('u1', null)
  assert.equal(bot.getState(GUILD_ID).botChannelId, null)
})

test('auto-leave: joining an empty channel leaves after the grace period', T, async () => {
  const { bot } = setupAlone()
  await bot.join(GUILD_ID, 'C1') // 人間が誰もいない
  await waitFor(() => bot.getState(GUILD_ID).botChannelId === null)
})

test('the bot itself is not counted as a human', T, async () => {
  const { fake, bot } = setupAlone()
  fake.setUser('u1', 'C1')
  await bot.join(GUILD_ID, 'C1')
  assert.equal(fake.guild.voiceStates.cache.get(BOT_ID).channelId, 'C1')
  fake.setUser('u1', null)
  await waitFor(() => bot.getState(GUILD_ID).botChannelId === null)
})
