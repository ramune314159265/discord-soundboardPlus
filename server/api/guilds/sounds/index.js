import { Router } from 'express'
import { SoundResource } from '../../../bot/soundresource.js'

export const soundsRouter = Router({ mergeParams: true })

soundsRouter.get('/', (req, res) => {
	res.json(SoundResource.guildAudios[req.params.guildId] ?? {})
})

soundsRouter.post('/', (req, res) => {
	SoundResource.add(req.params.guildId, {
		audioName: 'test',
		audioEmoji: '😀'
	})
	res.status(200).json({
		guildId: req.params.guildId,
		name: 'test',
		emoji: '😀'
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
