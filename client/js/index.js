import { DiscordSDK } from "@discord/embedded-app-sdk"
import { appInit } from './init'
import './sounds/buttonElement'

export let auth

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID

export const discordSdk = new DiscordSDK(clientId)

const setupDiscordSdk = async () => {
	await discordSdk.ready()
	console.log("Discord SDK is ready")

	const { code } = await discordSdk.commands.authorize({
		client_id: clientId,
		response_type: "code",
		state: "",
		prompt: "none",
		scope: [
			"identify",
			"guilds",
		],
	})

	const response = await fetch("/api/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			code,
		}),
	})
	const { access_token } = await response.json()

	auth = await discordSdk.commands.authenticate({
		access_token,
	})

	if (auth == null) {
		throw new Error("Authenticate command failed")
	}
}

setupDiscordSdk().then(() => {
	console.log("Discord SDK is authenticated")

	appInit()
})
