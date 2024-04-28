import { soundsRouter } from './index.js'
import { SoundResource } from '../../../bot/soundresource.js'
import { VoiceSession } from '../../../bot/voicechannel.js'

soundsRouter.put('/:audioHash/', (req, res) => {
	const soundResource = SoundResource.guildAudios?.[req.params.guildId]?.[req.params.audioHash]
	const audioName = req.body.name
	const audioEmoji = req.body.emoji
	if (!soundResource) {
		return res.status(404).json({
			content: 'not found'
		})
	}
	soundResource.edit({
		audioName,
		audioEmoji
	})
	res.status(200).json({
		guildId: req.params.guildId,
		audioName,
		audioEmoji
	})
})

soundsRouter.delete('/:audioHash/', (req, res) => {
	const soundResource = SoundResource.guildAudios?.[req.params.guildId]?.[req.params.audioHash]
	if (!soundResource) {
		return res.status(404).json({
			content: 'not found'
		})
	}
	soundResource.remove()
	res.status(204)
})

soundsRouter.post('/:audioHash/play/', (req, res) => {
	if (!VoiceSession.guildVoices.get(req.params.guildId)) {
		return res.status(400).json({
			content: 'not joined'
		})
	}
	const hash = req.params.audioHash
	const soundResource = SoundResource.get(req.params.guildId, hash)
	if (!soundResource) {
		return res.status(404).json({
			content: 'not found'
		})
	}
	VoiceSession.guildVoices.get(req.params.guildId).playSoundResource(soundResource)
	res.status(200).json({
		guildId: req.params.guildId,
		hash
	})
})
