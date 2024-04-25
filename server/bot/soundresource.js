import { createAudioResource } from '@discordjs/voice'
import { loadJsonFile } from 'load-json-file'
import { writeJsonFile } from 'write-json-file'
import crypto from 'crypto'
import fs from "node:fs/promises"
import path from 'path'

export class SoundResource {
	static guildAudios = {}
	static async add(guildId, {
		audioName,
		audioEmoji,
		audioFile
	}) {
		const audioHash = crypto.createHash('sha1').update(crypto.randomBytes(12).toString('hex')).digest('hex')
		SoundResource.guildAudios[guildId] ??= {}
		SoundResource.guildAudios[guildId][audioHash] = {}
		SoundResource.guildAudios[guildId][audioHash].name = audioName
		SoundResource.guildAudios[guildId][audioHash].audioEmoji = audioEmoji
		audioFile.mv(path.join(import.meta.dirname, `../resources/audio/${audioHash}.mp3`))
		await writeJsonFile(path.join(import.meta.dirname, '../resources/resources.json'), SoundResource.guildAudios)
		return audioHash
	}
	static get(guildId, audioHash) {
		return new SoundResource(guildId, {
			...SoundResource.guildAudios[guildId][audioHash],
			audioHash
		})
	}
	static {
		(async () => {
			SoundResource.guildAudios = await loadJsonFile(path.join(import.meta.dirname, '../resources/resources.json'))
		})()
	}
	constructor(guildId, {
		audioHash,
		audioName,
		audioEmoji
	}) {
		this.audioPath = path.join(import.meta.dirname, '../resources/audio/' + `${audioHash}.mp3`)
		this.audioHash = audioHash
		this.audioName = audioName
		this.audioEmoji = audioEmoji
		this.guildId = guildId
	}
	get resource() {
		return createAudioResource(this.audioPath)
	}
	async edit({
		audioName,
		audioEmoji
	}) {
		SoundResource.guildAudios[this.guildId][this.audioHash].name = audioName ?? this.audioName
		SoundResource.guildAudios[this.guildId][this.audioHash].audioEmoji = audioEmoji ?? this.audioEmoji
		writeJsonFile(path.join(import.meta.dirname, '../resources/resources.json'), SoundResource.guildAudios)
	}
	async remove() {
		delete SoundResource.guildAudios[this.guildId][this.audioHash]
		writeJsonFile(path.join(import.meta.dirname, '../resources/resources.json'), SoundResource.guildAudios)
		await fs.unlink(this.audioPath)
	}
}
