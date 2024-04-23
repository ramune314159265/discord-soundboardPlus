import { Router } from 'express'
import { VoiceSession } from '../../bot/voicechannel.js'
import { soundsRouter } from './sounds/index.js'

export const guildRouter = new Router({ mergeParams: true })
guildRouter.use('/sounds/', soundsRouter)

guildRouter.get('/', (req, res) => {
	const guildId = req.params.guildId
	const voiceSession = VoiceSession.guildVoices.get(guildId)
	if (!voiceSession) {
		return res.status(404).json({
			content: 'not joined',
			guildId
		})
	}
	res.status(200).json({
		voiceChannelId: voiceSession.voiceChannel.id,
		guildId
	})
})

guildRouter.post('/join/', (req, res) => {
	const guildId = req.params.guildId
	const voiceSession = VoiceSession.guildVoices.get(guildId)
	if (voiceSession) {
		return res.status(400).json({
			content: 'already joined',
			guildId
		})
	}
	const voiceChannelId = req.query.channelid
	if (!voiceChannelId) {
		return res.status(400).json({
			content: 'channelId is not set'
		})
	}
	try {
		new VoiceSession(voiceChannelId).connect()
	} catch (e) {
		console.error(e)
		return res.status(500).json({
			content: 'error'
		})
	}
})

guildRouter.post('/leave/', (req, res) => {
	const guildId = req.params.guildId
	const voiceSession = VoiceSession.guildVoices.get(guildId)
	if (!voiceSession) {
		return res.status(404).json({
			content: 'not joined',
			guildId
		})
	}
	voiceSession.disconnect()
})
