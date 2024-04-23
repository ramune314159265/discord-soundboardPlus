import { Router } from 'express'
import { guildRouter } from './guilds/index.js'

export const apiMainRouter = new Router({ mergeParams: true })
apiMainRouter.use('/guilds/:guildId/', guildRouter)
