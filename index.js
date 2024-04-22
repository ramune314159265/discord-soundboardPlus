import express from 'express'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const PORT = process.env.SERVER_PORT

app.use(express.static('web'))

app.listen(PORT, () => {
	console.log(`server started. port:${PORT}`)
})
