import EventEmitter2 from 'eventemitter2'
import { discordSdk } from '../discordsdk'
import { websocket } from './ws'

export class Sounds extends EventEmitter2 {
	constructor() {
		super()
		this.list = {}
		this.wsEventListener = 0

		this.init()
	}
	async init() {
		this.list = await (await fetch(`/api/guilds/${discordSdk.guildId}/sounds`)).json()
		this.emit('updated')
		this.wsEventListener = websocket.addEventListener('message', event => {
			const data = JSON.parse(event.data)
			switch (data.type) {
				case 'sound_played': {
					this.emit('sound.played', data.hash)
					break
				}
				case 'sound_stopped': {
					this.emit('sound.stopped', data.hash)
					break
				}
			}
		})
	}
	async play(hash) {
		await fetch(`/api/guilds/${discordSdk.guildId}/sounds/${hash}/play/`, { method: 'POST' })
	}
}
