import express from "express"
import fileUpload from "express-fileupload"
import { apiMainRouter } from './api/index.js'

export const app = express()
const port = 3001

app.use(express.json())
app.use(
	express.urlencoded({
		extended: true,
	})
)
app.use(fileUpload())
app.use('/api/', apiMainRouter)
import('./sdk/index.js')

app.listen(port, () => {
	console.log(`Server listening at http://localhost:${port}`)
})
