import { ThemeProvider, createTheme } from '@mui/material/styles'
import './index'

export default function App() {
	const theme = createTheme({
		palette: {
			mode: 'dark'
		}
	})

	return (
		<>
			<ThemeProvider theme={theme}>
				<span>test</span>
			</ThemeProvider >
		</>
	)
}
