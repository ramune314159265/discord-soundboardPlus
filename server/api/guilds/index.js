import { Router } from 'express'
import { VoiceSession } from '../../bot/voicechannel.js'
import { soundsRouter } from './sounds/index.js'

export const guildRouter = Router({ mergeParams: true })
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

guildRouter.ws('/ws/', (ws, req) => {
	const guildId = req.params.guildId
	const voiceSession = VoiceSession.guildVoices.get(guildId)
	if (!voiceSession) {
		ws.close(1000, 'not joined')
		return
	}
	const playedHandle = soundResource => {
		ws.send(JSON.stringify({
			type: 'sound_played',
			hash: soundResource.audioHash
		}))
	}
	const stoppedHandle = soundResource => {
		ws.send(JSON.stringify({
			type: 'sound_stopped',
			hash: soundResource.audioHash
		}))
	}
	voiceSession.on('soundPlayed', playedHandle)
	voiceSession.on('soundStopped', stoppedHandle)
	ws.on('close', () => {
		voiceSession.removeListener('soundPlayed', playedHandle)
		voiceSession.removeListener('soundStopped', stoppedHandle)
	})
})
