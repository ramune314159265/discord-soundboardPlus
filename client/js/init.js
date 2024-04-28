import { auth, discordSdk } from './index.js'

export const appInit = async () => {
	try {
		const currentGuild = (await (await fetch(`https://discord.com/api/v10/users/@me/guilds`, {
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				'Content-Type': 'application/json',
			},
		})).json()).find((g) => g.id === discordSdk.guildId)

		document.querySelector('.guildIcon').src = `https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.webp?size=32`

		const channel = await discordSdk.commands.getChannel({ channel_id: discordSdk.channelId })
		document.querySelector('.guildChannelName').textContent = `${currentGuild.name} > #${channel.name}`
	} catch (e) {
		console.error('can not get guild:' + e)
	}
}
