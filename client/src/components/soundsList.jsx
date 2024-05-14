import Box from '@mui/material/Box'
import { useState } from 'react'
import { sounds } from '../api/soundboard'
import Sound from './sound'

export default function SoundsList() {
	const [soundsList, setSoundsList] = useState(sounds.list)
	sounds.on('updated', () => {
		setSoundsList(sounds.list)
	})

	return (
		<Box sx={{
			p: '16px',
			display: 'flex',
			flexDirection: 'row',
			flexWrap: 'wrap',
			gap: '16px'
		}}>
			{
				Object.entries(soundsList)
					.map(([hash, data]) => {
						return (
							<Sound
								name={data.name}
								emoji={data.audioEmoji}
								hash={hash}
								key={hash}
								onClick={() => { sounds.play(hash) }}
							/>
						)
					})
			}
		</Box>
	)
}
