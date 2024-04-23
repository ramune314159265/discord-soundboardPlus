import express from "express"
import { apiMainRouter } from './api/index.js'

export const app = express()
const port = 3001

app.use(express.json())
app.use('/api/', apiMainRouter)

app.listen(port, () => {
	console.log(`Server listening at http://localhost:${port}`)
})
