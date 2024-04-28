import { discordSdk } from '..'

export class SoundListUI {
	constructor() {
		this.component = document.createElement('div')
		this.component.classList.add('soundsList')
		this.websocket = null
		this.buttonElementMap = new Map()
	}
	async show(target) {
		target.appendChild(this.component)
		await this.set()

		this.websocket = new WebSocket(`${location.protocol === 'http' ? 'ws' : 'wss'}://${location.host}/api/guilds/${discordSdk.guildId}/ws/`)
		this.websocket.addEventListener('message', event => {
			const data = JSON.parse(event.data)
			switch (data.type) {
				case 'sound_played': {
					this.buttonElementMap.get(data.hash)?.classList?.add?.('playing')
					break
				}
				case 'sound_stopped': {
					this.buttonElementMap.get(data.hash)?.classList?.remove?.('playing')
					break
				}
			}
		})
	}
	async set() {
		this.component.innerHTML = ''
		const sounds = await (await fetch(`/api/guilds/${discordSdk.guildId}/sounds`)).json()
		Object.entries(sounds)
			.forEach(([hash, sound]) => {
				const soundElement = document.createElement('soundboard-sound')
				soundElement.setAttribute('emoji', sound.audioEmoji)
				soundElement.setAttribute('name', sound.name)
				this.buttonElementMap.set(hash, soundElement)
				this.component.appendChild(soundElement)
				soundElement.addEventListener('click', () => {
					if (soundElement.classList.contains('playing')) {
						return
					}
					fetch(`/api/guilds/${discordSdk.guildId}/sounds/${hash}/play/`, { method: 'POST' })
				})
			})
	}
}
