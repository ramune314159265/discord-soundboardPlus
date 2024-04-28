export class SoundElement extends HTMLElement {
	constructor() {
		super()
	}
	static get observedAttributes() {
		return ['emoji', 'name']
	}
	#set() {
		console.log('a')
		this.appendChild(document.getElementById('soundUI').content.cloneNode(true))
		this.querySelector('.soundEmoji').textContent = this.getAttribute('emoji')
		this.querySelector('.soundName').textContent = this.getAttribute('name')
	}
	connectedCallback() {
		this.#set()
	}
	attributeChangedCallback() {
		this.#set()
	}
}

customElements.define('soundboard-sound', SoundElement)
