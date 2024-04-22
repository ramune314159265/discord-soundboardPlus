import express from "express"
import dotenv from "dotenv"
dotenv.config({ path: "../.env" })

export const app = express()
const port = 3001

app.use(express.json())

app.listen(port, () => {
	console.log(`Server listening at http://localhost:${port}`)
})
