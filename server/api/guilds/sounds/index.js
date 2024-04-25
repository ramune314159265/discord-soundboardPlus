import { Router } from 'express'
import { SoundResource } from '../../../bot/soundresource.js'

export const soundsRouter = Router({ mergeParams: true })

soundsRouter.get('/', (req, res) => {
	res.json(SoundResource.guildAudios[req.params.guildId] ?? {})
})

soundsRouter.post('/', async (req, res) => {
	const audioFile = req.files.audio.length ? req.files.audio[0] : req.files.audio
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

import('./sound.js')
