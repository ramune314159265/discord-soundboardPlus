import { AudioPlayerStatus, createAudioPlayer, joinVoiceChannel } from '@discordjs/voice'
import { EventEmitter } from 'events'

import { Events } from 'discord.js'
import { client } from './index.js'

export class VoiceSession extends EventEmitter {
	static {
		client.on(Events.VoiceStateUpdate, (oldState, newState) => {
			// 切断以外はスルー
			if (!(newState.channelId === null && oldState.channelId !== null)) {
				return
			}
			if (!VoiceSession.guildVoices.has(oldState.channel.guildId)) {
				return
			}
			if (oldState.channel.members.size !== 1) {
				return
			}
			VoiceSession.guildVoices.get(oldState.channel.guildId).disconnect()
		})
	}
	static guildVoices = new Map()
	constructor(channelId) {
		super()
		this.voiceChannel = client.channels.cache.get(channelId)
		if (!this.voiceChannel.isVoiceBased) {
			throw new Error('channel is not voice channel')
		}
		this.connection = null
		this.player = null
	}
	connect() {
		this.connection = joinVoiceChannel({
			adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
			channelId: this.voiceChannel.id,
			guildId: this.voiceChannel.guild.id,
			selfDeaf: true,
			selfMute: false,
		})
		this.player = createAudioPlayer()
		this.connection.subscribe(this.player)
		VoiceSession.guildVoices.set(this.voiceChannel.guildId, this)
	}
	async playSoundResource(soundResource) {
		if (!this.player) {
			return
		}
		this.player.play(soundResource.resource)
		this.emit('soundPlayed', soundResource)
		const stateChangeHandle = (oldState, newState) => {
			if (newState.status !== AudioPlayerStatus.Idle) {
				return
			}
			this.player.stop()
			this.emit('soundStopped', soundResource)
			this.player.removeListener('stateChange', stateChangeHandle)
		}
		this.player.on('stateChange', stateChangeHandle)
	}
	disconnect() {
		if (!this.connection) {
			return
		}
		this.connection.destroy()
		VoiceSession.guildVoices.delete(this.voiceChannel.guildId)
	}
}
