import { discordSdk } from '../discordsdk'

export const websocket = new WebSocket(`${location.protocol === 'http' ? 'ws' : 'wss'}://${location.host}/api/guilds/${discordSdk.guildId}/ws/`)
