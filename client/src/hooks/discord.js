import { createContext } from 'react'

export const discordContext = createContext({
	data: {
		guildId: '',
		guildName: '',
		guildIcon: '',
		channelName: ''
	},
	setData: (data) => data
})
