import express from "express"
import expressWs from 'express-ws'
import fileUpload from "express-fileupload"

export const app = express()
const port = 3001

expressWs(app)
app.use(express.json())
app.use(
	express.urlencoded({
		extended: true,
	})
)
app.use(fileUpload())
app.use('/api/', (await import('./api/index.js')).apiMainRouter)
import('./sdk/index.js')

app.listen(port, () => {
	console.log(`Server listening at http://localhost:${port}`)
})
