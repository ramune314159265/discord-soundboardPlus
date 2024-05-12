import { discordSdk } from '.'

export const joinVoiceChannel = async () => {
	const guildStatus = (await fetch(`/api/guilds/${discordSdk.guildId}/`)).status
	if (guildStatus === 404) {
		await (await fetch(`/api/guilds/${discordSdk.guildId}/join?channelid=${discordSdk.channelId}`, { method: 'POST' })).json()
	}
}
