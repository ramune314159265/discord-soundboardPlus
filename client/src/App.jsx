import { ThemeProvider, createTheme } from '@mui/material/styles'
import { useState } from 'react'
import './api/discordsdk/index'
import { auth, discordSdk, setupDiscordSdk } from './api/discordsdk/index'
import Header from './components/header'

export default function App() {
	const theme = createTheme({
		palette: {
			mode: 'dark'
		}
	})

	const [discordData, setDiscordData] = useState({
		guildId: '',
		guildName: '',
		guildIcon: '',
		channelName: ''
	})
	setupDiscordSdk()
		.then(async () => {
			const currentGuild = (await (await fetch(`https://discord.com/api/v10/users/@me/guilds`, {
				headers: {
					Authorization: `Bearer ${auth.access_token}`,
					'Content-Type': 'application/json',
				},
			})).json()).find((g) => g.id === discordSdk.guildId)
			const channel = await discordSdk.commands.getChannel({ channel_id: discordSdk.channelId })
			setDiscordData({
				guildId: discordSdk.guildId,
				guildName: currentGuild.name,
				guildIcon: `https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.webp?size=32`,
				channelName: channel.name
			})
		}).catch(console.error)

	return (
		<>
			<ThemeProvider theme={theme}>
				<Header discordData={discordData}></Header>
			</ThemeProvider >
		</>
	)
}
