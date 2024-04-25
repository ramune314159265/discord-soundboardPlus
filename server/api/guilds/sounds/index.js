import { Router } from 'express'
import { SoundResource } from '../../../bot/soundresource.js'
import { VoiceSession } from '../../../bot/voicechannel.js'

export const soundsRouter = Router({ mergeParams: true })

soundsRouter.get('/', (req, res) => {
	res.json(SoundResource.guildAudios[req.params.guildId] ?? {})
})

soundsRouter.post('/', async (req, res) => {
	const audioFile = req.files.audio[0] ?? req.files.audio
	const audioName = req.body.name
	const audioEmoji = req.body.emoji
	await SoundResource.add(req.params.guildId, {
		audioName,
		audioEmoji,
		audioFile
	})
	res.status(200).json({
		guildId: req.params.guildId,
		name: audioName,
		emoji: audioEmoji
	})
})

soundsRouter.put('/', (req, res) => {
	const soundResource = SoundResource.guildAudios?.[req.params.guildId]?.['9a36182a8526c5a7a6a03ea4620f3ab29bde660e']
	if (!soundResource) {
		return res.status(404).json({
			content: 'not found'
		})
	}
	soundResource.edit({
		audioName: 'test1',
		audioEmoji: '😀'
	})
	res.status(200).json({
		guildId: req.params.guildId,
		name: 'test',
		emoji: '😀'
	})
})

soundsRouter.delete('/', (req, res) => {
	const soundResource = SoundResource.guildAudios?.[req.params.guildId]?.['9a36182a8526c5a7a6a03ea4620f3ab29bde660e']
	if (!soundResource) {
		return res.status(404).json({
			content: 'not found'
		})
	}
	soundResource.remove()
	res.status(204)
})

soundsRouter.post('/play/', (req, res) => {
	if (!VoiceSession.guildVoices.get(req.params.guildId)) {
		return res.status(400).json({
			content: 'not joined'
		})
	}
	const hash = '9a36182a8526c5a7a6a03ea4620f3ab29bde660e'
	const soundResource = SoundResource.get(req.params.guildId, hash)
	VoiceSession.guildVoices.get(req.params.guildId).playResource(soundResource.resource)
	res.status(200).json({
		guildId: req.params.guildId,
		hash
	})
})
