import { discordSdk } from '..'

export class SoundListUI {
	constructor() {
		this.component = document.createElement('div')
		this.component.classList.add('soundsList')
	}
	show(target) {
		target.appendChild(this.component)
		this.set()
	}
	async set() {
		this.component.innerHTML = ''
		const sounds = await (await fetch(`/api/guilds/${discordSdk.guildId}/sounds`)).json()
		Object.entries(sounds)
			.forEach(([id, sound]) => {
				const soundElement = document.createElement('soundboard-sound')
				soundElement.setAttribute('emoji', sound.audioEmoji)
				soundElement.setAttribute('name', sound.name)
				soundElement.dataset.id = id
				this.component.appendChild(soundElement)
				soundElement.addEventListener('click', () => {
					fetch(`/api/guilds/${discordSdk.guildId}/sounds/${id}/play/`, { method: 'POST' })
				})
			})
	}
}
