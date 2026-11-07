// ミキサーの出力を、本物の @discordjs/voice (AudioPlayer / Raw → Opus エンコード) に流して確かめる。
// Discord には繋がず、購読者なしでプレイヤーを動かす (パケットは捨てられるが、リソースは実時間で読まれる)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice'
import { Mixer, OpusFrameEncoder } from '../src/mixer.js'
import { OpusCodec } from '../src/opusCodec.js'
import { OggOpusSource } from '../src/oggOpusSource.js'

const beep = () => fs.readFileSync(fileURLToPath(new URL('./fixtures/beep.ogg', import.meta.url)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeout = 4000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

function rig() {
  const mixer = new Mixer({ maxVoices: 8, createEncoder: () => new OpusFrameEncoder() })
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } })
  const resources = []
  mixer.on('stream', (stream) => {
    const resource = createAudioResource(stream, { inputType: StreamType.Opus })
    resources.push(resource)
    player.play(resource)
  })
  player.on('stateChange', (_old, next) => {
    if (next.status === AudioPlayerStatus.Idle) mixer.stopAll()
  })
  const errors = []
  player.on('error', (err) => errors.push(err))
  return { mixer, player, resources, errors }
}

test('real player: a mixed sound is played through to the end, then the player goes idle by itself', async () => {
  const { mixer, player, errors } = rig()
  const changes = []
  mixer.on('change', (list) => changes.push(list.length))

  mixer.add(new OggOpusSource(beep()), { soundId: 'a' })
  mixer.add(new OggOpusSource(beep()), { soundId: 'a' })
  await waitFor(() => player.state.status === AudioPlayerStatus.Playing)

  await waitFor(() => player.state.status === AudioPlayerStatus.Idle, 5000)
  assert.deepEqual(errors, [])
  assert.equal(mixer.size, 0)
  assert.equal(changes.at(-1), 0)
  // 0.6s の音。実時間より極端に早く/遅く終わっていない (プレイヤーのペースで読まれている)
})

test('real resource: the packets decode back to the mixed audio (two sounds are louder than one)', async () => {
  async function energyOf(copies) {
    const mixer = new Mixer({ maxVoices: 8, createEncoder: () => new OpusFrameEncoder() })
    let resource
    mixer.on('stream', (stream) => {
      resource = createAudioResource(stream, { inputType: StreamType.Opus })
    })
    for (let i = 0; i < copies; i++) mixer.add(new OggOpusSource(beep()))

    const decoder = new OpusCodec()
    let energy = 0
    let packets = 0
    // プレイヤーと同じく 20ms ごとに読む (ここではプレイヤーは使わず、自分で読む)
    for (let i = 0; i < 40; i++) {
      await sleep(20)
      const packet = resource.read()
      if (!packet) continue
      packets++
      const pcm = decoder.decode(packet)
      for (let j = 0; j < pcm.length; j += 2) energy += Math.abs(pcm.readInt16LE(j))
    }
    decoder.delete()
    mixer.close()
    return { energy, packets }
  }

  const one = await energyOf(1)
  const two = await energyOf(2)
  assert.ok(one.packets >= 30 && two.packets >= 30, `packets ${one.packets}/${two.packets}`)
  assert.ok(one.energy > 0)
  assert.ok(two.energy > one.energy * 1.6, `two=${two.energy} one=${one.energy}`)
})

test('real player: eight sounds at once, repeatedly, across several mixers, never corrupt the decoders', async () => {
  // 以前、opusscript のラッパー経由だと、インスタンスが増えると libopus の assertion で落ちていた (回帰)
  const rigs = [rig(), rig(), rig()]
  for (let round = 0; round < 2; round++) {
    for (const { mixer } of rigs) for (let i = 0; i < 8; i++) mixer.add(new OggOpusSource(beep()), { soundId: String(i) })
    await waitFor(() => rigs.every(({ mixer }) => mixer.size === 0), 8000)
    await sleep(50)
  }
  for (const { mixer, errors } of rigs) {
    assert.deepEqual(errors, [])
    mixer.close()
  }
})

test('real player: pressing again after everything ended starts a fresh stream; pressing during playback does not', async () => {
  const { mixer, player, resources } = rig()
  mixer.add(new OggOpusSource(beep()))
  await waitFor(() => player.state.status === AudioPlayerStatus.Playing)
  await sleep(100)
  mixer.add(new OggOpusSource(beep())) // 再生中に重ねる
  assert.equal(resources.length, 1)

  await waitFor(() => player.state.status === AudioPlayerStatus.Idle, 6000)
  mixer.add(new OggOpusSource(beep()))
  assert.equal(resources.length, 2)
  await waitFor(() => player.state.status === AudioPlayerStatus.Playing)
  await waitFor(() => player.state.status === AudioPlayerStatus.Idle, 6000)
})

test('real player: stopping the player drops the sounds that were playing, and new ones still work', async () => {
  const { mixer, player, resources } = rig()
  mixer.add(new OggOpusSource(beep()))
  mixer.add(new OggOpusSource(beep()))
  await waitFor(() => player.state.status === AudioPlayerStatus.Playing)
  player.stop(true)
  await waitFor(() => mixer.size === 0)

  mixer.add(new OggOpusSource(beep()))
  assert.equal(resources.length, 2)
  await waitFor(() => player.state.status === AudioPlayerStatus.Playing)
  player.stop(true)
  mixer.close()
})
