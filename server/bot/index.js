import {
	Client,
	GatewayIntentBits,
	Partials,
	ActivityType,
} from 'discord.js'
import dotenv from 'dotenv'

dotenv.config({ path: "../.env" })

export const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildScheduledEvents,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildEmojisAndStickers,
		GatewayIntentBits.GuildInvites,
		GatewayIntentBits.MessageContent
	],
	partials: [
		Partials.Message,
		Partials.Channel,
		Partials.Reaction,
	],
	presence: {
		activities: [{
			type: ActivityType.Playing,
			name: 'サーバー'
		}],
		status: 'online'
	},
})

console.log('connecting discord...')

export const startAt = new Date()

client.login(process.env.DISCORD_BOT_TOKEN)
