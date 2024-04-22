import { entersState, AudioPlayerStatus, createAudioPlayer, joinVoiceChannel } from '@discordjs/voice'

import { client } from '.'

export class voiceSession {
	static guildVoices = new Map()
	constructor(channelId) {
		this.voiceChannel = client.channels.cache.get(channelId)
		if (!this.voiceChannel.isVoiceBased) {
			throw new Error('channel is not voice channel')
		}
		this.connection = null
		this.player = null
	}
	connect() {
		this.connection = joinVoiceChannel({
			adapterCreator: this.voiceChannel.voiceAdapterCreator,
			channelId: this.voiceChannel.id,
			guildId: this.voiceChannel.guild.id,
			selfDeaf: true,
			selfMute: false,
		})
		this.player = createAudioPlayer()
		this.connection.subscribe(this.player)
		voiceSession.guildVoices.set(this.voiceChannel.guildId, this)
	}
	async playResource(resource) {
		if (!this.player) {
			return
		}
		this.player.play(resource)
		await entersState(this.player, AudioPlayerStatus.Playing, 10 * 1000)
		await entersState(this.player, AudioPlayerStatus.Idle, 10 * 1000)
	}
	disconnect() {
		if (!this.connection) {
			return
		}
		this.connection.destroy()
		voiceSession.guildVoices.delete(this.voiceChannel.guildId)
	}
}
