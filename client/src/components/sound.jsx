import MoreVertIcon from '@mui/icons-material/MoreVert'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { sounds } from '../api/soundboard'

export default function Sound(props) {
	return (
		<Box
			style={{
				width: '15rem',
				height: '4rem'
			}}
			sx={{
				width: '15rem',
				bgcolor: '#272727',
				borderRadius: 1,
				width: '100%',
				'&.playing': {
					outlineColor: 'success.main',
					outlineStyle: 'solid',
					outlineWidth: 'thin'
				},
				display: 'flex',
				alignItems: 'center'
			}
			}
		>
			<ButtonBase
				sx={{
					width: '100%',
					height: '100%',
					paddingLeft: '16px',
					borderRadius: 1,
					flexGrow: 1,
					display: 'flex',
					gap: '16px',
					alignContent: 'flex-start',
					justifyContent: 'left'
				}}
				onClick={e => {
					sounds.play(props.hash)
					return false
				}}
			>
				<Typography fontSize={'1.5rem'}>{props.emoji}</Typography>
				<Typography
					sx={{
						textAlign: 'left',
						overflow: "hidden",
						textOverflow: "ellipsis",
						width: '8rem'
					}}
				>
					{props.name}
				</Typography>
			</ButtonBase>
			<IconButton aria-label="settings" sx={{
				width: '3rem',
				height: '3rem',
				aspectRatio: '1/1'
			}}>
				<MoreVertIcon />
			</IconButton>
		</ Box>
	)
}
