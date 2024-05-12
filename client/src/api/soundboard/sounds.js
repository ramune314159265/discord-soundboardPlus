import EventEmitter2 from 'eventemitter2'
import { discordSdk } from '../discordsdk'
import { websocket } from './ws'

export class Sounds extends EventEmitter2 {
	constructor() {
		super()
		this.sounds = {}
		this.wsEventListener = 0

		this.init()
	}
	async init() {
		this.sounds = await (await fetch(`/api/guilds/${discordSdk.guildId}/sounds`)).json()
		this.on('updated')
		this.wsEventListener = websocket.addEventListener('message', event => {
			const data = JSON.parse(event.data)
			switch (data.type) {
				case 'sound_played': {
					this.on('sound.played', data.hash)
					break
				}
				case 'sound_stopped': {
					this.on('sound.stopped', data.hash)
					break
				}
			}
		})
	}
}
