import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';

export default function Header(props) {
	return (
		<Box sx={{ flexGrow: 1 }}>
			<AppBar position="static">
				<Toolbar>
					<Typography variant="subtitle1" component="div" sx={{ flexGrow: 1 }}>
						サウンドボード+
					</Typography>
					<Stack direction={'row'} spacing={1}>
						<Avatar src={props.discordData.guildIcon} sx={{ width: 28, height: 28, bgcolor: 'transparent' }} >
							<CircularProgress size={'70%'} />
						</Avatar>
						<Typography variant="subtitle1" component="div">
							{`${props.discordData.guildName} > #${props.discordData.channelName}`}
						</Typography>
					</Stack>
				</Toolbar>
			</AppBar>
		</Box>
	)
}
