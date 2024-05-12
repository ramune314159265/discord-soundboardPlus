import MoreVertIcon from '@mui/icons-material/MoreVert'
import ButtonBase from '@mui/material/ButtonBase'
import CardHeader from '@mui/material/CardHeader'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'

export default function Sound(props) {
	return (
		<ButtonBase
			style={{
				width: '15rem'
			}}
			sx={{
				bgcolor: '#272727',
				borderRadius: 1,
				'&.playing': {
					outlineColor: 'success.main',
					outlineStyle: 'solid',
					outlineWidth: 'thin'
				}
			}}
			className='playing'
		>
			<CardHeader
				avatar={<Typography>{props.emoji}</Typography>}
				title={props.name}
				titleTypographyProps={{
					sx: {
						textAlign: 'left',
						overflow: "hidden",
						textOverflow: "ellipsis",
						width: '8rem'
					},
					noWrap: true
				}}
				sx={{ width: '100%' }}
				action={
					<IconButton aria-label="settings">
						<MoreVertIcon />
					</IconButton>
				}
			/>
		</ButtonBase>
	)
}
